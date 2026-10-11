import { describe, expect, test } from "bun:test";
import { normalizeError } from "../src/errors";
import type { NormalizedError } from "../src/errors";

describe("normalizeError", () => {
	test.each([408, 429, 500, 502, 503, 504])("allows bounded retries for HTTP %i", (status) => {
		const failure = { status, message: "Provider request failed" };
		expect(normalizeError(failure)).toEqual({
			category: "provider",
			message: failure.message,
			retryable: true,
			cause: failure,
		});
	});

	test.each([400, 401, 403, 404, 422])("does not retry HTTP %i even when prose mentions network trouble", (statusCode) => {
		const failure = { statusCode, message: "Invalid token; retry after a network timeout or abort" };
		expect(normalizeError(failure)).toMatchObject({ category: "provider", retryable: false });
	});

	test.each([
		{ status: 429, body: { error: { type: "insufficient_quota", message: "Billing limit reached" } } },
		{ statusCode: 429, responseBody: '{"error":{"code":"insufficient_quota","message":"Billing limit reached"}}' },
	])("permanent quota failures do not inherit rate-limit retries", failure => {
		expect(normalizeError(failure)).toMatchObject({ category: "provider", retryable: false });
	});

	test("reads nested response status without treating an SDK retry hint as authority", () => {
		const failure = { message: "Unauthorized", isRetryable: true, response: { status: 401 } };
		expect(normalizeError(failure)).toMatchObject({ category: "provider", retryable: false });
	});

	test("recognizes overflow hidden in an SDK JSON response body", () => {
		const failure = Object.assign(new Error("Bad request"), {
			statusCode: 400,
			responseBody: JSON.stringify({ error: { code: "context_length_exceeded", message: "Context budget exhausted" } }),
		});
		expect(normalizeError(failure, { toolName: "search" })).toMatchObject({
			category: "context_overflow", retryable: false, cause: failure,
		});
	});

	test("extracts a provider message from a structured body", () => {
		const failure = { status: 429, body: { error: { message: "Rate limit reached", code: "rate_limit_exceeded" } } };
		expect(normalizeError(failure)).toMatchObject({
			category: "provider", message: "Rate limit reached", retryable: true,
		});
	});

	test("uses a plain response body when no error message is supplied", () => {
		expect(normalizeError({ status: 503, responseBody: "Service unavailable" })).toMatchObject({
			message: "Service unavailable", retryable: true,
		});
	});

	test("recognizes provider code without HTTP status", () => {
		expect(normalizeError({ error: { code: "rate_limit_exceeded", message: "Try later" } })).toMatchObject({
			category: "provider", retryable: true,
		});
		expect(normalizeError({ code: "invalid_api_key", message: "Authentication failed" })).toMatchObject({
			category: "provider", retryable: false,
		});
	});

	test.each([
		"This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
		"prompt is too long: 210000 tokens > 200000 maximum",
		"Context window exceeded",
	])("recognizes a specific overflow message: %s", (message) => {
		expect(normalizeError(message)).toMatchObject({ category: "context_overflow", retryable: false });
	});

	test("does not confuse authentication tokens or provider abort prose with overflow or cancellation", () => {
		for (const message of ["Invalid authentication token", "Provider aborted request because the token is invalid"]) {
			expect(normalizeError(message)).toMatchObject({ category: "provider", retryable: false });
		}
	});

	test("preserves DOM abort identity and cancellation takes precedence over tool context", () => {
		const failure = new DOMException("The operation was aborted.", "AbortError");
		expect(normalizeError(failure, { toolName: "download" })).toEqual({
			category: "interrupted", message: failure.message, retryable: false, cause: failure,
		});
	});

	test.each(["ABORT_ERR", "ERR_ABORTED", "ERR_CANCELED"])("recognizes explicit cancellation code %s", (code) => {
		expect(normalizeError({ code, message: "Stopped" }, { toolName: "query" })).toMatchObject({
			category: "interrupted", retryable: false,
		});
	});

	test("distinguishes a request timeout from explicit cancellation", () => {
		expect(normalizeError(Object.assign(new Error("timeout"), { code: "ECONNABORTED" }))).toMatchObject({
			category: "provider", retryable: true,
		});
		expect(normalizeError(new DOMException("Deadline elapsed", "TimeoutError"))).toMatchObject({
			category: "provider", retryable: true,
		});
		expect(normalizeError("Request timed out")).toMatchObject({ category: "provider", retryable: true });
	});

	test.each(["Failed to fetch", "fetch failed", "Network request failed"])("retries fetch TypeError %s", (message) => {
		expect(normalizeError(new TypeError(message))).toMatchObject({ category: "provider", retryable: true });
	});

	test("does not turn arbitrary programmer TypeErrors into retry storms", () => {
		expect(normalizeError(new TypeError("Cannot read properties of undefined"))).toMatchObject({
			category: "provider", retryable: false,
		});
	});

	test("reads a transport failure from an Error cause while retaining the outer Error", () => {
		const failure = new Error("Provider transport failed", { cause: { code: "ECONNRESET" } });
		const result = normalizeError(failure);
		expect(result).toMatchObject({ category: "provider", retryable: true });
		expect(result.cause).toBe(failure);
	});

	test.each([
		new Error("SSE stream interrupted"),
		{ code: "SSE_INTERRUPTED", message: "Stream ended before completion" },
		{ name: "StreamInterruptedError", message: "Unexpected EOF" },
	])("retries an unexpected SSE transport interruption rather than requiring resume", (failure) => {
		expect(normalizeError(failure)).toMatchObject({ category: "provider", retryable: true });
	});

	test("tool failure does not inherit provider retry policy", () => {
		const failure = { status: 503, message: "Search upstream unavailable" };
		expect(normalizeError(failure, { toolName: "search" })).toMatchObject({
			category: "tool_failure", retryable: false, cause: failure,
		});
	});

	test("already normalized errors keep their policy and original cause", () => {
		const cause = new Error("Original provider error");
		const failure: NormalizedError = Object.freeze({
			category: "provider", message: "Already classified", retryable: true, cause,
		});
		expect(normalizeError(failure, { toolName: "search" })).toBe(failure);
		expect(normalizeError(failure).cause).toBe(cause);
	});

	test("a malformed normalized-looking object cannot grant itself retries", () => {
		expect(normalizeError({ category: "provider", message: "Invalid shape", retryable: "true" })).toMatchObject({
			category: "provider", retryable: false,
		});
	});

	test("supports the legacy HTTP error message without retrying authentication errors", () => {
		expect(normalizeError("API error 401: Unauthorized")).toMatchObject({ category: "provider", retryable: false });
		expect(normalizeError("API error 503: Service unavailable")).toMatchObject({ category: "provider", retryable: true });
	});

	test("finds overflow inside the legacy HTTP error JSON body", () => {
		expect(normalizeError('API error 400: {"error":{"code":"context_length_exceeded","message":"Too much input"}}')).toMatchObject({
			category: "context_overflow", retryable: false,
		});
	});

	test("accepts a string HTTP status from provider envelopes", () => {
		expect(normalizeError({ statusCode: "429", message: "Throttled" })).toMatchObject({
			category: "provider", retryable: true,
		});
	});

	test("an explicit authentication code overrides timeout text without HTTP metadata", () => {
		expect(normalizeError({ code: "invalid_api_key", message: "Request timed out" })).toMatchObject({
			category: "provider", retryable: false,
		});
	});

	test("recognizes explicit operation cancellation text without abort substring matching", () => {
		expect(normalizeError("The operation was aborted.")).toMatchObject({
			category: "interrupted", retryable: false,
		});
	});

	test.each([undefined, null, "", "   ", 17, {}, new Error("Unrecognized failure")])("defaults unknown failures to a nonretryable provider error", (failure) => {
		const result = normalizeError(failure);
		expect(result.category).toBe("provider");
		expect(result.retryable).toBe(false);
		expect(typeof result.message).toBe("string");
		expect(result.message.length).toBeGreaterThan(0);
		expect(result.cause).toBe(failure);
	});

	test("does not serialize circular provider response objects", () => {
		const failure: { status: number; message: string; cause?: unknown } = { status: 503, message: "Unavailable" };
		failure.cause = failure;
		expect(normalizeError(failure)).toMatchObject({ category: "provider", retryable: true });
		expect(normalizeError(failure).cause).toBe(failure);
	});
});

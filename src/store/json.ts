export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue | undefined };

type JsonObject = { [key: string]: JsonValue | undefined };

function ownData(value: object, key: PropertyKey): PropertyDescriptor | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) return undefined;
	return descriptor;
}

function normalize(value: unknown, stack: WeakSet<object>): JsonValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "object") return undefined;
	if (stack.has(value)) return undefined;
	stack.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
			const ownKeys = Reflect.ownKeys(value);
			const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
			if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return undefined;
			for (const key of ownKeys) {
				if (key === "length") continue;
				if (typeof key !== "string" || !/^\d+$/.test(key) || Number(key) >= lengthDescriptor.value || String(Number(key)) !== key) return undefined;
			}
			const result: JsonValue[] = [];
			for (let index = 0; index < lengthDescriptor.value; index++) {
				const descriptor = ownData(value, String(index));
				if (!descriptor) return undefined;
				const item = normalize(descriptor.value, stack);
				if (item === undefined && descriptor.value !== undefined) return undefined;
				if (item === undefined) return undefined;
				result.push(item);
			}
			return result;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		const result: JsonObject = {};
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") return undefined;
			const descriptor = ownData(value, key);
			if (!descriptor) return undefined;
			if (descriptor.value === undefined) continue;
			const item = normalize(descriptor.value, stack);
			if (item === undefined) return undefined;
			Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true });
		}
		return result;
	} catch {
		return undefined;
	} finally {
		stack.delete(value);
	}
}

function normalized(value: unknown): JsonValue {
	const result = normalize(value, new WeakSet<object>());
	if (result === undefined) throw new TypeError("Value is not strict JSON data");
	return result;
}

export function isJsonValue(value: unknown): value is JsonValue {
	try {
		return normalize(value, new WeakSet<object>()) !== undefined;
	} catch {
		return false;
	}
}

export function cloneJson<T>(value: T): T {
	return normalized(value) as T;
}

function stringify(value: JsonValue): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stringify).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map(key => `${JSON.stringify(key)}:${stringify(value[key] as JsonValue)}`).join(",")}}`;
}

export function canonicalJson(value: unknown): string {
	return stringify(normalized(value));
}

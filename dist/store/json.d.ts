export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue | undefined;
};
export declare function isJsonValue(value: unknown): value is JsonValue;
export declare function cloneJson<T>(value: T): T;
export declare function canonicalJson(value: unknown): string;
//# sourceMappingURL=json.d.ts.map
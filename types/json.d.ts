/** Recursive JSON type shared by storage and plugin-facing JSDoc contracts. */
export interface JsonObject { [name: string]: JsonValue }
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

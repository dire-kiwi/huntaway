type Schema = {
    $ref?: string;
    oneOf?: Schema[];
    const?: unknown;
    enum?: unknown[];
    type?: string | string[];
    required?: string[];
    properties?: {
        [k: string]: Schema;
    };
    additionalProperties?: Schema | boolean;
    items?: Schema;
    minItems?: number;
    minimum?: number;
    format?: string;
    contentEncoding?: string;
};
declare const defs: {
    [name: string]: Schema;
};
/** The names of the protocol's definitions: Command, ThreadEvent, Snapshot... */
export type SchemaName = keyof typeof defs & string;
/**
 * What's wrong with `value` as the definition `name` (e.g. "Command"), as "path: problem"
 * strings; none when it's valid.
 */
export declare function validate(value: unknown, name: SchemaName): string[];
export {};

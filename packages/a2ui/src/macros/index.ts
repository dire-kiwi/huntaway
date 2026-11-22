// A2UI macros (HE-77), ported from the Python agent SDK at commit 5ff1b05f
// (python/a2ui_agent/src/a2ui/transformers/macros/__init__.py): `macro()` declares a high-level component, and
// `MacroExpander` lists the macros in the catalogs an inference format prompts with and lowers them to the transport
// catalogs' components. v1.0 only. Apache-2.0, as the code it ports; see the header of each module.

export { macro, MacroDefinition, MacroProtocolError, normalizeVersionFamily, validateV1MacroName } from "./macro.ts"
export type { AnyMacro, Macro, MacroInstance, MacroOptions, MacroParameter, MacroResult, MacroSchemaOptions, MacroVersionFamily } from "./macro.ts"
export { param } from "./params.ts"
export type {
  AnyParam,
  CallArgs,
  LiteralValue,
  ObjectField,
  Param,
  ParamFactory,
  ParamOptions,
  Params,
  ParamType,
  Presence,
  RenderArgs,
  SimpleKind,
  ValueOf,
} from "./params.ts"
export { DEFAULT_COMMON_REF_PREFIX, typeSchema } from "./schema.ts"
export { coerceValue } from "./coerce.ts"
export { DEFAULT_MACRO_CATALOG_ID } from "./catalogs.ts"
export { MacroExpander } from "./expander.ts"
export type { MacroExpanderOptions, MacroLog, MessageLike, OnError, TransformToTransportOptions } from "./expander.ts"
export { withBareEnvelopeKeys } from "./envelope.ts"
export type { EnvelopeKeys } from "./envelope.ts"

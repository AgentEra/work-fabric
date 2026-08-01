export type RuntimeJsonPrimitive = string | number | boolean | null;
export type RuntimeJsonValue =
  | RuntimeJsonPrimitive
  | readonly RuntimeJsonValue[]
  | { readonly [key: string]: RuntimeJsonValue };
export type RuntimeJsonObject = {
  readonly [key: string]: RuntimeJsonValue;
};

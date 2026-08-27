/** JSON values are the only data custom views may receive across the journal/frame boundary. */
export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

type IsJsonCompatible<T> = [T] extends [JsonPrimitive]
  ? true
  : T extends (...args: any[]) => unknown
    ? false
    : T extends readonly (infer Item)[]
      ? IsJsonCompatible<Item>
      : T extends object
        ? false extends {
            [Key in keyof T]-?: IsJsonCompatible<Exclude<T[Key], undefined>>;
          }[keyof T]
          ? false
          : true
        : false;

type RequireJson<Props, Label extends string> =
  false extends IsJsonCompatible<Props> ? { readonly [Key in Label]: never } : unknown;

export type UiViewMode = "input" | "display";

/** Maximum UTF-8 JSON payload accepted by custom UI protocol v1. */
export const UI_PROTOCOL_MAX_PROPS_BYTES = 512 * 1024;

/**
 * The opaque value workflow code receives for a `.ui.tsx` import.
 *
 * The browser build sees the full definition returned by `defineUiView`; the Node
 * workflow build replaces the module with an inert token carrying only `assetKey`.
 * The phantom fields preserve props/answer/mode inference without entering runtime data.
 */
export interface UiViewRef<Props, Answer = never, Mode extends UiViewMode = UiViewMode> {
  readonly kind: "weft.ui-view";
  readonly __props?: Props;
  readonly __answer?: Answer;
  readonly __mode?: Mode;
}

export type InputUiView<Props, Answer> = UiViewRef<Props, Answer, "input">;
export type DisplayUiView<Props> = UiViewRef<Props, never, "display">;

export interface InputViewProps<Props, Answer> {
  props: Props;
  /** Stage a candidate answer. Only host-owned chrome can submit it to the workflow. */
  propose(answer: Answer): void;
}

export interface ResultViewProps<Props> {
  props: Props;
}

export interface InputUiViewDefinition<Props, Answer> extends InputUiView<Props, Answer> {
  id: string;
  revision: string;
  mode: "input";
  component(props: InputViewProps<Props, Answer>): unknown;
}

export interface DisplayUiViewDefinition<Props> extends DisplayUiView<Props> {
  id: string;
  revision: string;
  mode: "display";
  component(props: ResultViewProps<Props>): unknown;
}

export function defineUiView<Props, Answer>(
  definition: {
    id: string;
    revision?: string;
    component(props: InputViewProps<Props, Answer>): unknown;
  } & RequireJson<Props, "__ui_props_must_be_json"> &
    RequireJson<Answer, "__ui_answer_must_be_json">,
): InputUiViewDefinition<Props, Answer> {
  return Object.freeze({
    kind: "weft.ui-view",
    mode: "input",
    ...definition,
    revision: definition.revision ?? "auto",
  });
}

export function defineResultView<Props>(
  definition: {
    id: string;
    revision?: string;
    component(props: ResultViewProps<Props>): unknown;
  } & RequireJson<Props, "__ui_props_must_be_json">,
): DisplayUiViewDefinition<Props> {
  return Object.freeze({
    kind: "weft.ui-view",
    mode: "display",
    ...definition,
    revision: definition.revision ?? "auto",
  });
}

/** Token emitted into the Node workflow bundle by the gate compiler. */
export interface CompiledUiViewToken extends UiViewRef<unknown> {
  assetKey: string;
}

/** One browser program produced by the gate. Bytes are stored content-addressably before journaling. */
export interface CompiledUiAsset {
  assetKey: string;
  id: string;
  revision: string;
  mode: UiViewMode;
  protocol: 1;
  code: string;
  hash: string;
}

/** The asset graph paired with one compiled workflow definition. */
export interface CompiledUiCatalog {
  buildHash: string;
  assets: CompiledUiAsset[];
}

export interface UiRenderOptions<Props> {
  /** Unique replay identity for this call site. */
  key: string;
  /** Optional projection identity for choosing the latest presentation in a UI region. */
  slot?: string;
  view: DisplayUiView<Props>;
  props: Props;
}

export interface UiApi {
  render<Props>(opts: UiRenderOptions<Props> & RequireJson<Props, "__ui_props_must_be_json">): Promise<void>;
}

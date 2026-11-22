import { clsx } from "clsx"
import * as Icons from "lucide-react"
import { createContext, useContext, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { createComponentImplementation, type ReactCatalogComponent } from "@a2ui/react"
import type { ResolvedChildRef } from "@a2ui/web_core"
import { basicCatalogOf, basicComponent } from "@huntaway/a2ui/express"
import { Button, Input, Modal, Textarea } from "../../../ui"
import { Markdown } from "../Markdown"
import { forInput } from "./dates"

// A2UI's basic catalog (v1.0) drawn with the board's own controls (HE-77): the components' names, props and checks are
// the published catalog's (`@huntaway/a2ui/express`'s `basicComponent`), so what the server checks is what draws here;
// only the look is the board's. Media isn't loaded from an agent's URL, as in the thread's Markdown (MarkdownView.tsx):
// a URL can carry a secret out as soon as it's shown, so an image, a video or a sound from the web is a link to it, and
// one written into the block (a data: URL) is shown.

/** Whether the surface being drawn is locked (a click on it sent, A2uiView.tsx): what draws outside it (a Modal) obeys it. */
export const SurfaceLocked = createContext(false)

/** The props as the binder resolves them: typed by the catalog's schema at runtime, so read here with care. */
type Props = Readonly<Record<string, unknown>> & {
  readonly setValue?: (value: unknown) => void
  readonly action?: () => unknown
  readonly isValid?: boolean
  readonly validationErrors?: ReadonlyArray<string>
}
type Build = (id: string, basePath?: string) => ReactNode

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "")
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback)
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null && !Array.isArray(v)
const isChildRef = (v: unknown): v is ResolvedChildRef => isRecord(v) && typeof v["id"] === "string"

function component(name: string, render: (props: Props, build: Build) => ReactNode): ReactCatalogComponent {
  const api = basicComponent(name)
  if (api === undefined) throw new Error(`A2UI's basic catalog has no ${name}`)
  return createComponentImplementation(api, ({ props, buildChild }) => render(isRecord(props) ? props : {}, buildChild))
}

/** A component's children, as ids or (in a template) refs with their data path. */
function children(props: Props, build: Build): ReactNode[] {
  const list: ReadonlyArray<unknown> = Array.isArray(props["children"]) ? props["children"] : []
  return list.map((c) =>
    typeof c === "string" ? (
      <Child key={c} id={c} build={build} />
    ) : isChildRef(c) ? (
      <Child key={`${c.id}@${c.basePath}`} id={c.id} base={c.basePath} build={build} />
    ) : null,
  )
}

const Child = ({ id, base, build }: { id: string; base?: string | undefined; build: Build }) => <>{build(id, base)}</>

const one = (props: Props, key: string, build: Build): ReactNode => {
  const id = props[key]
  return typeof id === "string" ? build(id) : null
}

const JUSTIFY: Readonly<Record<string, string>> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  spaceBetween: "justify-between",
  spaceAround: "justify-around",
  spaceEvenly: "justify-evenly",
  stretch: "justify-stretch",
}
const ALIGN: Readonly<Record<string, string>> = { start: "items-start", center: "items-center", end: "items-end", stretch: "items-stretch" }

/** Grows in a Row or Column by its `weight`, as the catalog says. */
const grow = (props: Props) => (typeof props["weight"] === "number" ? { flexGrow: props["weight"], flexBasis: 0, minWidth: 0 } : undefined)

function FieldError({ props }: { props: Props }) {
  const first = props.validationErrors?.[0]
  if (props.isValid !== false || first === undefined) return null
  return <span className="block text-xs text-red-400">{first}</span>
}

function Label({ text }: { text: string }) {
  return text === "" ? null : <span className="block text-xs font-medium text-muted">{text}</span>
}

const ICONS: Readonly<Record<string, Icons.LucideIcon>> = {
  accountCircle: Icons.CircleUser,
  add: Icons.Plus,
  arrowBack: Icons.ArrowLeft,
  arrowForward: Icons.ArrowRight,
  attachFile: Icons.Paperclip,
  calendarToday: Icons.Calendar,
  call: Icons.Phone,
  camera: Icons.Camera,
  check: Icons.Check,
  close: Icons.X,
  delete: Icons.Trash2,
  download: Icons.Download,
  edit: Icons.Pencil,
  event: Icons.CalendarDays,
  error: Icons.CircleAlert,
  fastForward: Icons.FastForward,
  favorite: Icons.Heart,
  favoriteOff: Icons.HeartOff,
  folder: Icons.Folder,
  help: Icons.CircleHelp,
  home: Icons.House,
  info: Icons.Info,
  locationOn: Icons.MapPin,
  lock: Icons.Lock,
  lockOpen: Icons.LockOpen,
  mail: Icons.Mail,
  menu: Icons.Menu,
  moreVert: Icons.EllipsisVertical,
  moreHoriz: Icons.Ellipsis,
  notificationsOff: Icons.BellOff,
  notifications: Icons.Bell,
  pause: Icons.Pause,
  payment: Icons.CreditCard,
  person: Icons.User,
  phone: Icons.Smartphone,
  photo: Icons.Image,
  play: Icons.Play,
  print: Icons.Printer,
  refresh: Icons.RefreshCw,
  rewind: Icons.Rewind,
  search: Icons.Search,
  send: Icons.Send,
  settings: Icons.Settings,
  share: Icons.Share2,
  shoppingCart: Icons.ShoppingCart,
  skipNext: Icons.SkipForward,
  skipPrevious: Icons.SkipBack,
  star: Icons.Star,
  starHalf: Icons.StarHalf,
  starOff: Icons.StarOff,
  stop: Icons.Square,
  upload: Icons.Upload,
  visibility: Icons.Eye,
  visibilityOff: Icons.EyeOff,
  volumeDown: Icons.Volume1,
  volumeMute: Icons.VolumeX,
  volumeOff: Icons.VolumeOff,
  volumeUp: Icons.Volume2,
  warning: Icons.TriangleAlert,
}

/** A media URL the block carries itself (data:), which is safe to show; any other is a link to it. */
const inline = (url: string) => /^data:(image|video|audio)\//i.test(url)

function MediaLink({ url, what, label }: { url: string; what: string; label: string }) {
  const safe = /^https?:\/\//i.test(url) ? url : undefined
  return (
    <a href={safe} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[13px] text-accent hover:underline">
      <Icons.ExternalLink size={13} /> {label || what}
    </a>
  )
}

function Tabs({ props, build }: { props: Props; build: Build }) {
  const tabs = (Array.isArray(props["tabs"]) ? props["tabs"] : []).filter(isRecord)
  const [at, setAt] = useState(0)
  const shown = tabs[Math.min(at, tabs.length - 1)]
  return (
    <div className="min-w-0" style={grow(props)}>
      <div role="tablist" className="mb-2 flex gap-1 border-b border-line">
        {tabs.map((t, i) => (
          <button
            key={str(t["child"]) || str(t["title"])}
            role="tab"
            type="button"
            aria-selected={i === at}
            onClick={() => setAt(i)}
            className={clsx("-mb-px border-b-2 px-2.5 py-1.5 text-[13px]", i === at ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}
          >
            {str(t["title"])}
          </button>
        ))}
      </div>
      {shown !== undefined && typeof shown["child"] === "string" ? build(shown["child"]) : null}
    </div>
  )
}

/**
 * A trigger that opens a dialog. The trigger only opens it: a trigger Button's own action (the catalog requires one)
 * isn't sent, as it would start the agent's turn and lock the surface with the dialog open. The dialog is drawn on the
 * page's body, outside the surface's lock (`inert`, which would leave it open and unusable over the board), and closes
 * once the surface locks: a click in it was sent.
 */
function ModalOf({ props, build }: { props: Props; build: Build }) {
  const locked = useContext(SurfaceLocked)
  const [open, setOpen] = useState(false)
  if (open && locked) setOpen(false)
  return (
    <div style={grow(props)}>
      <div
        onClickCapture={(e) => {
          e.stopPropagation()
          if (!locked) setOpen(true)
        }}
      >
        {one(props, "trigger", build)}
      </div>
      {open &&
        !locked &&
        createPortal(
          <Modal title="" onClose={() => setOpen(false)}>
            <div data-a2ui-modal>{one(props, "content", build)}</div>
          </Modal>,
          document.body,
        )}
    </div>
  )
}

function ChoicePicker({ props }: { props: Props }) {
  const options = (Array.isArray(props["options"]) ? props["options"] : []).filter(isRecord)
  const selected: ReadonlyArray<string> = Array.isArray(props["value"]) ? props["value"].map(str) : []
  const multi = props["variant"] === "multipleSelection"
  const chips = props["displayStyle"] === "chips"
  const [filter, setFilter] = useState("")
  const toggle = (value: string) => props.setValue?.(multi ? (selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]) : [value])
  const shown = options.filter((o) => filter === "" || (str(o["label"]) || str(o["value"])).toLowerCase().includes(filter.toLowerCase()))
  return (
    <fieldset className="min-w-0 space-y-1.5" style={grow(props)}>
      {str(props["label"]) !== "" && <legend className="mb-1.5 text-xs font-medium text-muted">{str(props["label"])}</legend>}
      {props["filterable"] === true && <Input value={filter} placeholder="Filter" onChange={(e) => setFilter(e.target.value)} />}
      <div className={clsx(chips ? "flex flex-wrap gap-1.5" : "space-y-1")}>
        {shown.map((o) => {
          const value = str(o["value"])
          const on = selected.includes(value)
          const label = str(o["label"]) || value
          return chips ? (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(value)}
              className={clsx(
                "rounded-full border px-2.5 py-1 text-[12.5px] transition-colors",
                on ? "border-accent/60 bg-accent/15 text-fg" : "border-line bg-panel text-muted hover:text-fg",
              )}
            >
              {label}
            </button>
          ) : (
            <label key={value} className="flex cursor-pointer items-center gap-2 text-[13px] text-fg">
              <input type={multi ? "checkbox" : "radio"} checked={on} onChange={() => toggle(value)} className="accent-[var(--color-accent-strong)]" />
              {label}
            </label>
          )
        })}
      </div>
      <FieldError props={props} />
    </fieldset>
  )
}

const components: ReadonlyArray<ReactCatalogComponent> = [
  component("Text", (props) =>
    props["variant"] === "caption" ? (
      <p className="text-xs text-muted" style={grow(props)}>
        {str(props["text"])}
      </p>
    ) : (
      <div className="min-w-0 [&_.prose-chat>*:first-child]:mt-0 [&_.prose-chat>*:last-child]:mb-0" style={grow(props)}>
        <Markdown text={str(props["text"])} />
      </div>
    ),
  ),
  component("Image", (props) => {
    const url = str(props["url"])
    const fit = { contain: "object-contain", cover: "object-cover", fill: "object-fill", none: "object-none", scaleDown: "object-scale-down" }[
      str(props["fit"])
    ]
    const size = {
      icon: "size-6",
      avatar: "size-9 rounded-full",
      smallFeature: "max-h-24",
      mediumFeature: "max-h-48",
      largeFeature: "max-h-80",
      header: "max-h-40 w-full",
    }[str(props["variant"])]
    return inline(url) ? (
      <img src={url} alt={str(props["description"])} className={clsx("max-w-full rounded-md", fit, size)} style={grow(props)} />
    ) : (
      <MediaLink url={url} what="Image" label={str(props["description"])} />
    )
  }),
  component("Icon", (props) => {
    const Icon = ICONS[str(props["name"])] ?? Icons.Circle
    return <Icon size={16} className="shrink-0 text-muted" aria-label={str(props["name"])} />
  }),
  component("Video", (props) => {
    const url = str(props["url"])
    return inline(url) ? <video src={url} controls className="max-w-full rounded-md" style={grow(props)} /> : <MediaLink url={url} what="Video" label="" />
  }),
  component("AudioPlayer", (props) => {
    const url = str(props["url"])
    return inline(url) ? <audio src={url} controls style={grow(props)} /> : <MediaLink url={url} what="Audio" label={str(props["description"])} />
  }),
  component("Row", (props, build) => (
    <div className={clsx("flex min-w-0 flex-wrap gap-2", JUSTIFY[str(props["justify"])], ALIGN[str(props["align"]) || "center"])} style={grow(props)}>
      {children(props, build)}
    </div>
  )),
  component("Column", (props, build) => (
    <div className={clsx("flex min-w-0 flex-col gap-2.5", JUSTIFY[str(props["justify"])], ALIGN[str(props["align"])])} style={grow(props)}>
      {children(props, build)}
    </div>
  )),
  component("List", (props, build) => (
    <div
      className={clsx("flex min-w-0 gap-2", props["direction"] === "horizontal" ? "flex-row overflow-x-auto" : "flex-col", ALIGN[str(props["align"])])}
      style={grow(props)}
    >
      {children(props, build)}
    </div>
  )),
  component("Card", (props, build) => (
    <div className="min-w-0 rounded-lg border border-line bg-panel/60 p-3" style={grow(props)}>
      {one(props, "child", build)}
    </div>
  )),
  component("Divider", (props) =>
    props["axis"] === "vertical" ? <div className="w-px self-stretch bg-line" /> : <div className="h-px w-full bg-line" style={grow(props)} />,
  ),
  component("Tabs", (props, build) => <Tabs props={props} build={build} />),
  component("Modal", (props, build) => <ModalOf props={props} build={build} />),
  component("Button", (props, build) => (
    <Button
      size="sm"
      variant={props["variant"] === "primary" ? "primary" : props["variant"] === "borderless" ? "ghost" : "secondary"}
      disabled={props.isValid === false}
      onClick={() => void props.action?.()}
      style={grow(props)}
    >
      {one(props, "child", build)}
    </Button>
  )),
  component("TextField", (props) => {
    const variant = str(props["variant"])
    const common = {
      value: str(props["value"]),
      placeholder: str(props["placeholder"]),
      "aria-invalid": props.isValid === false || undefined,
    }
    return (
      <label className="block min-w-0 space-y-1.5" style={grow(props)}>
        <Label text={str(props["label"])} />
        {variant === "longText" ? (
          <Textarea {...common} rows={3} onChange={(e) => props.setValue?.(e.target.value)} />
        ) : (
          <Input
            {...common}
            type={variant === "obscured" ? "password" : variant === "number" ? "number" : "text"}
            onChange={(e) => props.setValue?.(variant === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)}
          />
        )}
        <FieldError props={props} />
      </label>
    )
  }),
  component("CheckBox", (props) => (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg" style={grow(props)}>
      <input
        type="checkbox"
        checked={props["value"] === true}
        onChange={(e) => props.setValue?.(e.target.checked)}
        className="accent-[var(--color-accent-strong)]"
      />
      {str(props["label"])}
      <FieldError props={props} />
    </label>
  )),
  component("ChoicePicker", (props) => <ChoicePicker props={props} />),
  component("Slider", (props) => {
    const min = num(props["min"], 0)
    const max = num(props["max"], 100)
    const steps = num(props["steps"], 0)
    return (
      <label className="block min-w-0 space-y-1.5" style={grow(props)}>
        <span className="flex justify-between text-xs font-medium text-muted">
          {str(props["label"])}
          <span className="tabular-nums">{str(props["value"])}</span>
        </span>
        <input
          type="range"
          className="w-full accent-[var(--color-accent-strong)]"
          min={min}
          max={max}
          step={steps > 0 ? (max - min) / steps : "any"}
          value={num(props["value"], min)}
          onChange={(e) => props.setValue?.(Number(e.target.value))}
        />
      </label>
    )
  }),
  component("DateTimeInput", (props) => {
    const date = props["enableDate"] !== false
    const time = props["enableTime"] === true
    const type = date && time ? "datetime-local" : time ? "time" : "date"
    const value = str(props["value"])
    // The input shows local time without a zone; the value keeps what the agent gave until the user changes it.
    const shown = forInput(type, value)
    return (
      <label className="block min-w-0 space-y-1.5" style={grow(props)}>
        <Label text={str(props["label"])} />
        <Input
          type={type}
          value={shown}
          min={forInput(type, str(props["min"])) || undefined}
          max={forInput(type, str(props["max"])) || undefined}
          onChange={(e) => props.setValue?.(e.target.value)}
        />
        <FieldError props={props} />
      </label>
    )
  }),
]

/** The basic catalog, drawn the board's way. */
export const boardCatalog = basicCatalogOf(components)

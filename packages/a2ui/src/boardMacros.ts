// The board's own A2UI macros (HE-77): what agents ask the user most, as one call each. A call costs the model a line
// (`root = Choice("Which approach?", [{label: "A", value: "a"}, …])`) where the same in basic components is a dozen,
// and the board lowers it to those components (`MacroExpander.transformToTransport`) before it draws it, so the
// renderer only knows the basic catalog. Each sends the agent one event with what the user picked.
import { Action, Button, Card, ChoicePicker, Column, DataBinding, Row, Text } from "./builder/index.ts"
import { macro, param } from "./macros/index.ts"

/** A question with options and a button that sends the pick. */
export const Choice = macro({
  name: "Choice",
  description:
    "A question with options to pick from and a button that sends the pick: you get the event `event` with context {choice: [the values picked]}. " +
    "Four or fewer short options show as chips, more as a list.",
  params: {
    question: param.dynamicString("The question, as a line of text (simple Markdown)."),
    options: param.array(param.choicePickerOption(), "The options, each {label, value}."),
    event: param.string("The event the button sends.", { default: "choose" }),
    button: param.string("The button's label.", { default: "Choose" }),
    multiple: param.boolean("Whether the user may pick more than one.", { default: false }),
  },
  render: ({ question, options, event, button, multiple }) => {
    // One data path per event, so two Choices on a surface (with different events) keep their picks apart.
    const picked = new DataBinding(`/choice/${event.replace(/[^A-Za-z0-9_]/g, "_")}`)
    const short = options.length <= 4 && options.every((o) => typeof o.label !== "string" || o.label.length <= 24)
    return Card({
      child: Column({
        children: [
          Text({ text: question }),
          ChoicePicker({
            options,
            value: picked,
            variant: multiple ? "multipleSelection" : "mutuallyExclusive",
            displayStyle: short ? "chips" : "checkbox",
          }),
          Row({
            justify: "end",
            children: [Button({ child: Text({ text: button }), variant: "primary", action: Action.event(event, { context: { choice: picked } }) })],
          }),
        ],
      }),
    })
  },
})

/** Something to confirm or call off, with a button for each. */
export const Confirm = macro({
  name: "Confirm",
  description:
    "Asks the user to confirm something: a title, an optional detail, and two buttons. Either sends the event `event`, " +
    "with context {confirmed: true} for the first and {confirmed: false} for the second.",
  params: {
    title: param.dynamicString("What to confirm, in a line (simple Markdown)."),
    detail: param.dynamicString("More about it, under the title.", { optional: true }),
    confirm: param.string("The confirming button's label.", { default: "Go ahead" }),
    cancel: param.string("The other button's label.", { default: "Cancel" }),
    event: param.string("The event either button sends.", { default: "confirm" }),
  },
  render: ({ title, detail, confirm, cancel, event }) =>
    Card({
      child: Column({
        children: [
          Text({ text: title }),
          ...(detail === undefined ? [] : [Text({ text: detail, variant: "caption" })]),
          Row({
            justify: "end",
            children: [
              Button({ child: Text({ text: cancel }), action: Action.event(event, { context: { confirmed: false } }) }),
              Button({ child: Text({ text: confirm }), variant: "primary", action: Action.event(event, { context: { confirmed: true } }) }),
            ],
          }),
        ],
      }),
    }),
})

/** Every macro the board offers. */
export const BOARD_MACROS = [Choice, Confirm]

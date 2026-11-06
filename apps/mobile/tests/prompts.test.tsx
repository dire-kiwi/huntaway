import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { askedQuestions, PermissionCard, pickOption, QuestionCard, typeAnswer } from "../src/prompts";

const none = { picked: [], text: "" };

describe("answering a question", () => {
  test("with one answer, an option and a typed answer replace each other, and a picked option unpicks", () => {
    let a = pickOption(none, "Red", false);
    expect(a).toEqual({ picked: ["Red"], text: "" });
    a = typeAnswer(a, "Green", false);
    expect(a).toEqual({ picked: [], text: "Green" });
    a = pickOption(a, "Blue", false);
    expect(a).toEqual({ picked: ["Blue"], text: "" });
    expect(pickOption(a, "Blue", false)).toEqual({ picked: [], text: "" });
    // Clearing the text leaves the option.
    expect(typeAnswer(a, " ", false)).toEqual({ picked: ["Blue"], text: " " });
  });

  test("with several answers, options and text go together", () => {
    let a = pickOption(none, "Red", true);
    a = pickOption(a, "Blue", true);
    a = typeAnswer(a, "and green", true);
    expect(a).toEqual({ picked: ["Red", "Blue"], text: "and green" });
    expect(pickOption(a, "Red", true).picked).toEqual(["Blue"]);
  });

  test("picking an option, then typing another answer, sends only the typed one", async () => {
    const answerQuestion = jest.fn(async () => ({}) as never);
    const onDone = jest.fn();
    await render(
      <QuestionCard
        client={{ answerQuestion }}
        hostId="h"
        taskId="t"
        messageId={5}
        data={{ question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }], multi_select: false, allow_other: true, status: "pending" }}
        onDone={onDone}
      />,
    );
    await fireEvent.press(screen.getByText("Red"));
    expect(screen.getByRole("button", { name: "Red" }).props.accessibilityState).toMatchObject({ selected: true });
    await fireEvent.changeText(screen.getByLabelText("Your answer"), "Green");
    expect(screen.getByRole("button", { name: "Red" }).props.accessibilityState).toMatchObject({ selected: false });
    await fireEvent.press(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(answerQuestion).toHaveBeenCalledWith("h", "t", 5, { choices: [], text: "Green" });
  });

  test("without a typed answer, a tap answers", async () => {
    const answerQuestion = jest.fn(async () => ({}) as never);
    await render(
      <QuestionCard
        client={{ answerQuestion }}
        hostId="h"
        taskId="t"
        messageId={6}
        data={{ question: "Go?", options: ["Yes", "No"].map((label) => ({ label })), allow_other: false }}
        onDone={() => {}}
      />,
    );
    await fireEvent.press(screen.getByText("No"));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith("h", "t", 6, { choices: ["No"], text: null }));
  });
});

describe("question prompts", () => {
  // As the server's Codex adapter asks them (agent/codex/adapter.rs): a permission prompt for request_user_input.
  const codex = {
    questions: [
      { id: "colour", header: "Colour", question: "Which colour?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }], isOther: false },
      { id: "name", question: "What should it be called?", options: [], isOther: false },
      { id: "key", question: "The API key?", options: [{ label: "Skip" }], isOther: true, isSecret: true },
    ],
  };

  test("Codex's questions are answered with picks and typed answers, not allowed bare", async () => {
    const resolvePermission = jest.fn(async () => ({}) as never);
    const onDone = jest.fn();
    await render(<PermissionCard client={{ resolvePermission }} hostId="h" id="p1" tool="request_user_input" input={codex} onDone={onDone} />);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    // The first takes no answer of the user's own; the second has no options, so it needs one.
    expect(screen.queryByLabelText("Your answer to: Which colour?")).toBeNull();
    const answer = screen.getByRole("button", { name: "Send answers" });
    expect(answer.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByText("Blue"));
    await fireEvent.changeText(screen.getByLabelText("Your answer to: What should it be called?"), " Widget ");
    await fireEvent.changeText(screen.getByLabelText("Your answer to: The API key?"), "sk-123");
    expect(screen.getByLabelText("Your answer to: The API key?").props.secureTextEntry).toBe(true);
    await fireEvent.press(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(resolvePermission).toHaveBeenCalledWith("h", "p1", "allow", undefined, { answers: [["Blue"], ["Widget"], ["sk-123"]] });
  });

  test("Claude's AskUserQuestion takes a typed answer in place of an option", async () => {
    const resolvePermission = jest.fn(async () => ({}) as never);
    const input = { questions: [{ question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] }] };
    await render(<PermissionCard client={{ resolvePermission }} hostId="h" id="p2" tool="AskUserQuestion" input={input} onDone={() => {}} />);
    await fireEvent.press(screen.getByText("Red"));
    await fireEvent.changeText(screen.getByLabelText("Your answer to: Which colour?"), "Green");
    await fireEvent.press(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(resolvePermission).toHaveBeenCalledWith("h", "p2", "allow", undefined, { answers: [["Green"]] }));
  });

  test("dismissing declines with a note, and other tools are allowed or denied", async () => {
    const resolvePermission = jest.fn(async () => ({}) as never);
    await render(<PermissionCard client={{ resolvePermission }} hostId="h" id="p3" tool="request_user_input" input={codex} onDone={() => {}} />);
    await fireEvent.press(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(resolvePermission).toHaveBeenCalledWith("h", "p3", "deny", expect.stringContaining("dismissed"), undefined));
    expect(askedQuestions("Bash", { questions: codex.questions })).toHaveLength(3);
    await render(<PermissionCard client={{ resolvePermission }} hostId="h" id="p4" tool="Bash" input={{ command: "ls" }} onDone={() => {}} />);
    await fireEvent.press(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(resolvePermission).toHaveBeenCalledWith("h", "p4", "allow", undefined, undefined));
  });
});

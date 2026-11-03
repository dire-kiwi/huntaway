import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { pickOption, QuestionCard, typeAnswer } from "../src/prompts";

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
    await render(<QuestionCard client={{ answerQuestion }} hostId="h" taskId="t" messageId={6} data={{ question: "Go?", options: ["Yes", "No"].map((label) => ({ label })), allow_other: false }} onDone={() => {}} />);
    await fireEvent.press(screen.getByText("No"));
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith("h", "t", 6, { choices: ["No"], text: null }));
  });
});

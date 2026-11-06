// A board's notifications on this phone: on or off, the events it pushes (as the web board's Settings → Notifications
// has them for each device), whose permission prompts, with Allow and Deny on the notification, and a test.
import { EXPO_PUSH_API, NOTIFY_EVENTS, PUSH_PROMPTS, type PushDevice, type PushEvents } from "@huntaway/client";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, ScrollView, Switch, Text, View } from "react-native";
import { retryPush, setBoardEvents, setBoardPush, supported, usePushState } from "../../notifications";
import { assistantPushEvents, subscriptionOn, withEvent } from "../../push";
import { boards, clientFor, statusOf, usable, useBoards, useBoardStatuses, useLoad } from "../../session";
import { colors } from "../../theme";
import { Button, Chip, Empty, ErrorText, s } from "../../ui";

function problemText(problem: string) {
  switch (problem) {
    case "denied":
      return "Notifications are turned off for Huntaway in this phone's settings. Allow them there, then try again.";
    case "no_project":
      return "This build of the app has no EAS project id (extra.eas.projectId in app.json), which push needs. Use a build made with EAS, or set one up with eas init.";
    case "unsupported":
      return "Push needs the app on a phone: Android or iOS.";
    default:
      return `Push couldn't be set up: ${problem}`;
  }
}

export default function BoardNotifications() {
  const { board: boardId } = useLocalSearchParams<{ board: string }>();
  useBoards();
  const board = boards.board(boardId);
  const status = statusOf(useBoardStatuses(), boardId);
  const push = usePushState();
  const on = board?.push !== false;
  const ok = !!board && usable(status) && board.apiVersion >= EXPO_PUSH_API;
  const subscribed = push.subscribed[boardId];
  // What the board has for this phone: what subscribing gave, or else read from it.
  const loaded = useLoad(async () => (ok && on && push.token ? subscriptionOn(clientFor(board!), push.token) : null), [boardId, ok, on, push.token, subscribed?.device?.id]);
  const [device, setDevice] = useState<PushDevice | null>(null);
  useEffect(() => setDevice(subscribed?.device ?? loaded.data ?? null), [subscribed?.device, loaded.data]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tested, setTested] = useState(false);

  if (!board) return <Empty title="That board isn't paired with this phone." />;

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    setTested(false);
    try {
      await f();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const change = (events: PushEvents) => {
    if (!device) return;
    const before = device;
    setDevice({ ...device, events });
    setBoardEvents(board, device, events).catch((e) => {
      setDevice(before);
      setErr(e instanceof Error ? e.message : String(e));
    });
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Stack.Screen options={{ title: `Notifications · ${board.name}` }} />
      {!supported ? (
        <Text style={s.muted}>{problemText("unsupported")}</Text>
      ) : board.apiVersion < EXPO_PUSH_API ? (
        <Text style={s.muted}>
          {board.name} runs an older Huntaway (API {board.apiVersion}), which can't push to the app. Update it to push here (API {EXPO_PUSH_API} or
          later).
        </Text>
      ) : (
        <>
          <View style={[s.card, s.row, { marginHorizontal: 0 }]}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.title}>Push to this phone</Text>
              <Text style={s.faint}>{board.name} sends these to this phone, also while the app is closed. Tapping one opens its task.</Text>
            </View>
            <Switch
              value={on}
              disabled={busy}
              onValueChange={(v) => void run(() => setBoardPush(board, v))}
              accessibilityLabel="Push to this phone"
              trackColor={{ true: colors.accentStrong, false: colors.line }}
            />
          </View>
          {!on && push.pendingOff.includes(board.id) && (
            <Text style={{ color: colors.amber, fontSize: 14 }}>
              {board.name} couldn't be told yet, so it may still push here: it's told as soon as it can be reached.
            </Text>
          )}
          {on && push.problem && (
            <View style={{ gap: 8 }}>
              <Text style={{ color: colors.amber, fontSize: 14 }}>{problemText(push.problem)}</Text>
              <View style={s.row}>
                {push.problem === "denied" && <Button title="Open settings" small onPress={() => void Linking.openSettings()} />}
                <Button title="Try again" small onPress={retryPush} />
              </View>
            </View>
          )}
          {on && !ok && !push.problem && <Text style={s.muted}>{board.name} isn't reachable now: its notifications can be set once it is.</Text>}
          {on && subscribed?.error && <ErrorText>Couldn't subscribe on {board.name}: {subscribed.error}</ErrorText>}
          {on && device && (
            <>
              <View style={[s.card, { marginHorizontal: 0 }]}>
                {NOTIFY_EVENTS.map((e) => (
                  <View key={e.id} style={[s.row, { minHeight: 40 }]}>
                    <Text style={[s.muted, { flex: 1, color: colors.fg }]}>{e.label}</Text>
                    <Switch
                      value={device.events[e.id]}
                      onValueChange={(v) => change(withEvent(device.events, e.id, v))}
                      accessibilityLabel={e.label}
                      trackColor={{ true: colors.accentStrong, false: colors.line }}
                    />
                  </View>
                ))}
              </View>
              {assistantPushEvents(device.events).length > 0 && (
                <View style={[s.card, { marginHorizontal: 0 }]}>
                  <Text style={s.title}>Assistant</Text>
                  <Text style={s.faint}>A reply opens its thread, and a report its routine's. Neither says what was written.</Text>
                  {assistantPushEvents(device.events).map((e) => (
                    <View key={e.id} style={[s.row, { minHeight: 40 }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={[s.muted, { color: colors.fg }]}>{e.label}</Text>
                        <Text style={s.faint}>{e.hint}</Text>
                      </View>
                      <Switch
                        value={!!device.events[e.id]}
                        onValueChange={(v) => change(withEvent(device.events, e.id, v))}
                        accessibilityLabel={e.label}
                        trackColor={{ true: colors.accentStrong, false: colors.line }}
                      />
                    </View>
                  ))}
                </View>
              )}
              <View style={[s.card, { marginHorizontal: 0 }]}>
                <Text style={s.title}>Permission prompts</Text>
                <Text style={s.faint}>
                  With Allow and Deny on the notification, which answer without opening the app (allowing asks you to unlock the phone). It names the tool,
                  not what it's run with: questions and plans open the task.
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                  {PUSH_PROMPTS.map((p) => (
                    <Chip key={p.id} label={p.label} selected={(device.events.prompts ?? "assistant") === p.id} onPress={() => change({ ...device.events, prompts: p.id })} />
                  ))}
                </View>
              </View>
              <View style={s.row}>
                <Button
                  title="Send a test"
                  small
                  busy={busy}
                  onPress={() =>
                    void run(async () => {
                      await clientFor(board).testPush(device.id);
                      setTested(true);
                    })
                  }
                />
              </View>
              {tested && <Text style={{ color: colors.green, fontSize: 14 }}>Sent. It should show in a moment.</Text>}
              {device.last_error && <Text style={{ color: colors.amber, fontSize: 14 }}>The last push failed: {device.last_error}</Text>}
            </>
          )}
          {err && <ErrorText>{err}</ErrorText>}
        </>
      )}
    </ScrollView>
  );
}

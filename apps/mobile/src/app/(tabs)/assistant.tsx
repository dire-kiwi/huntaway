import { useAtomValue } from "@effect/atom-react"
import { assistantHome, query, taskAtom } from "@huntaway/client"
import { ProfileId } from "@huntaway/contracts"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { KeyboardAvoidingView, Platform, View } from "react-native"
import { Composer } from "../../components/composer"
import { ThreadView } from "../../components/thread"
import { Empty, s } from "../../components/ui"
import { errorText } from "../../state/action"
import { useBoard, useProfile } from "../../state/board"

// The shown profile's assistant: found where the board keeps it (`assistantHome`, possibly another host), asked for
// there (`assistant.get`, which makes it the first time), then its thread and a composer, as a task's.

function AssistantThread({ host, taskId }: { readonly host: string; readonly taskId: string }) {
  const task = useAtomValue(taskAtom({ host_id: host, id: taskId }))
  if (task === undefined) return <Empty icon="sparkles-outline" title="Opening your assistant…" />
  return (
    <>
      <View style={{ flex: 1 }}>
        <ThreadView host={host} task={task} emptyTitle="Ask your assistant anything." />
      </View>
      <Composer host={host} taskId={taskId} running={task.running} queued={task.queued_message} placeholder="Ask your assistant" />
    </>
  )
}

function AssistantOf({ host, profileId }: { readonly host: string; readonly profileId: string }) {
  const result = useAtomValue(query("assistant.get", host, { profile_id: ProfileId.make(profileId), here: true }))
  if (AsyncResult.isFailure(result))
    return <Empty icon="alert-circle-outline" title="Your assistant can't be opened." hint={errorText(Cause.squash(result.cause))} />
  if (!AsyncResult.isSuccess(result)) return <Empty icon="sparkles-outline" title="Opening your assistant…" />
  return <AssistantThread host={host} taskId={result.value.id} />
}

export default function AssistantScreen() {
  const profile = useProfile()
  const profiles = useBoard((b) => b.profiles)
  const hosts = useBoard((b) => b.hosts)
  const home = profile === null ? undefined : assistantHome(profiles, hosts, profile)
  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
      {home === undefined ? (
        <Empty title={profile === null ? "Loading the board…" : "No host has this profile."} />
      ) : home.profileId === undefined ? (
        <Empty title={home.unavailable === "offline" ? "Your assistant's host is offline." : "Your assistant's host has no profile of this name."} />
      ) : (
        <AssistantOf key={`${home.hostId}/${home.profileId}`} host={home.hostId} profileId={home.profileId} />
      )}
    </KeyboardAvoidingView>
  )
}

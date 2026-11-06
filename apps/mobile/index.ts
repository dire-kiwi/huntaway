// The app's entry. What handles taps on notifications is set up first: a tap on Allow or Deny can start the app in the
// background (on Android, a task; on iOS, the response listener), with none of its screens, and must find it there.
import { startNotifications } from "./src/notifications";
import "expo-router/entry";

startNotifications();

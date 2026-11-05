import { Link, Stack } from "expo-router";
import { View } from "react-native";
import { Empty, s } from "../ui";

export default function NotFound() {
  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: "Not found" }} />
      <Empty title="There's nothing here.">
        <Link href="/" style={{ color: "#8b7cf6", fontSize: 15 }}>
          Go to the inbox
        </Link>
      </Empty>
    </View>
  );
}

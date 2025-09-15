import { View, Text, StyleSheet } from "react-native";
export default function Settings() {
  return (
    <View style={styles.c}><Text style={styles.t}>Settings screen</Text></View>
  );
}
const styles = StyleSheet.create({ c:{flex:1,justifyContent:"center",alignItems:"center"}, t:{color:"#fff"}});

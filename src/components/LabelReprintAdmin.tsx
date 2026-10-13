import React, { useState } from "react";
import { View, StyleSheet, ActivityIndicator, TouchableOpacity, ScrollView } from "react-native";
import { Text, TextInput, Switch } from "react-native-paper";
import { Ionicons } from "@expo/vector-icons";
import { useMutation } from "@tanstack/react-query";
import apiClient from "../api/client";
import { t } from "../i18n";

interface Door {
    cycle: number;
    totalCycles: number;
    startedAt: string;
    printed: number;
    lastPrintedAt: string | null;
}

const fmt = (iso: string) =>
    new Date(iso).toLocaleString("cs-CZ", {
        timeZone: "Europe/Prague",
        day: "numeric",
        month: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });

/**
 * Admin panel for printing an order's Hardware box labels again. P2L only
 * signals each door once, so this replays the label printing for doors that
 * have already started (see the backend's reprintOrderLabels):
 *  - by default only labels that never printed come out;
 *  - "print everything again" prints every label of the chosen doors from
 *    the current CSV — for when the CSV data changed after printing.
 * No QR sticker, documentation or workstation state is touched.
 */
export default function LabelReprintAdmin({
    authHeaders,
    onMessage,
}: {
    authHeaders: Record<string, string>;
    onMessage: (message: string) => void;
}) {
    const [salesOrder, setSalesOrder] = useState("");
    const [position, setPosition] = useState("");
    const [doors, setDoors] = useState<Door[] | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [force, setForce] = useState(false);
    const onError = (error: any) => onMessage(error?.response?.data?.error || error.message);

    const load = useMutation({
        mutationFn: async () =>
            (
                await apiClient.get("/workstations/label-status", {
                    params: { salesOrder: salesOrder.trim(), position: position.trim() },
                    headers: authHeaders,
                })
            ).data as { doors: Door[] },
        onSuccess: (data) => {
            setDoors(data.doors);
            setSelected(new Set(data.doors.map((d) => d.cycle)));
        },
        onError,
    });

    const reprint = useMutation({
        mutationFn: async () =>
            (
                await apiClient.post(
                    "/workstations/reprint-labels",
                    {
                        salesOrder: salesOrder.trim(),
                        position: position.trim(),
                        force,
                        cycles: [...selected].sort((a, b) => a - b),
                    },
                    { headers: authHeaders, timeout: 60000 },
                )
            ).data as { results: { cycle: number; printed: number }[] },
        onSuccess: (data) => {
            const total = data.results.reduce((n, r) => n + r.printed, 0);
            onMessage(total > 0 ? t("labelsAdmin.printed", { count: total }) : t("labelsAdmin.nothingMissing"));
            setForce(false);
            load.mutate();
        },
        onError,
    });

    const toggle = (cycle: number) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(cycle)) next.delete(cycle);
            else next.add(cycle);
            return next;
        });

    const canLoad = !!salesOrder.trim() && !!position.trim() && !load.isPending;
    const canPrint = !!doors?.length && selected.size > 0 && !reprint.isPending;

    return (
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
            <Text variant="bodySmall" style={styles.hint}>
                {t("labelsAdmin.hint")}
            </Text>
            <View style={styles.row}>
                <TextInput
                    mode="outlined"
                    label={t("labelsAdmin.salesOrder")}
                    value={salesOrder}
                    onChangeText={(v) => (setSalesOrder(v), setDoors(null))}
                    keyboardType="number-pad"
                    style={{ flex: 2 }}
                />
                <TextInput
                    mode="outlined"
                    label={t("labelsAdmin.position")}
                    value={position}
                    onChangeText={(v) => (setPosition(v), setDoors(null))}
                    keyboardType="number-pad"
                    style={{ flex: 1 }}
                    onSubmitEditing={() => canLoad && load.mutate()}
                />
            </View>
            <TouchableOpacity
                style={[styles.btn, styles.btnSecondary, !canLoad && styles.btnDisabled]}
                disabled={!canLoad}
                onPress={() => load.mutate()}>
                {load.isPending ?
                    <ActivityIndicator size="small" color="#ff5100" />
                :   <Text style={styles.btnSecondaryText}>{t("labelsAdmin.load")}</Text>}
            </TouchableOpacity>

            {doors && doors.length === 0 && (
                <Text style={styles.empty}>{t("labelsAdmin.noDoors")}</Text>
            )}

            {doors && doors.length > 0 && (
                <>
                    <Text variant="titleSmall" style={{ marginTop: 16, marginBottom: 6 }}>
                        {t("labelsAdmin.doors")}
                    </Text>
                    {doors.map((d) => {
                        const on = selected.has(d.cycle);
                        return (
                            <TouchableOpacity key={d.cycle} style={styles.door} onPress={() => toggle(d.cycle)}>
                                <Ionicons
                                    name={on ? "checkbox" : "square-outline"}
                                    size={22}
                                    color={on ? "#ff5100" : "#909090"}
                                />
                                <View style={{ flex: 1, marginLeft: 10 }}>
                                    <Text variant="bodyMedium" style={{ fontWeight: "bold" }}>
                                        {t("labelsAdmin.door", { cycle: d.cycle, total: d.totalCycles })}
                                    </Text>
                                    <Text variant="bodySmall" style={{ color: "#777" }}>
                                        {t("labelsAdmin.doorInfo", { started: fmt(d.startedAt), count: d.printed })}
                                    </Text>
                                </View>
                            </TouchableOpacity>
                        );
                    })}

                    <View style={styles.forceRow}>
                        <View style={{ flex: 1 }}>
                            <Text variant="bodyMedium">{t("labelsAdmin.force")}</Text>
                            <Text variant="bodySmall" style={{ color: "#777" }}>
                                {t("labelsAdmin.forceHint")}
                            </Text>
                        </View>
                        <Switch value={force} onValueChange={setForce} color="#ff5100" />
                    </View>

                    <TouchableOpacity
                        style={[styles.btn, !canPrint && styles.btnDisabled]}
                        disabled={!canPrint}
                        onPress={() => reprint.mutate()}>
                        {reprint.isPending ?
                            <ActivityIndicator size="small" color="#fff" />
                        :   <Text style={styles.btnText}>
                                {force ? t("labelsAdmin.printAll") : t("labelsAdmin.printMissing")}
                            </Text>
                        }
                    </TouchableOpacity>
                </>
            )}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { padding: 16 },
    hint: { color: "#666", marginBottom: 12 },
    row: { flexDirection: "row", gap: 8 },
    empty: { marginTop: 16, color: "#777", textAlign: "center" },
    door: {
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderWidth: 1,
        borderColor: "#eee",
        borderRadius: 8,
        marginBottom: 6,
    },
    forceRow: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 12 },
    btn: {
        backgroundColor: "#ff5100",
        borderRadius: 10,
        paddingVertical: 14,
        alignItems: "center",
        marginTop: 8,
    },
    btnText: { color: "#fff", fontWeight: "bold", fontSize: 16 },
    btnSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#ff5100" },
    btnSecondaryText: { color: "#ff5100", fontWeight: "bold" },
    btnDisabled: { opacity: 0.4 },
});

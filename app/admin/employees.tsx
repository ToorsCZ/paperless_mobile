import React, { useEffect, useState } from "react";
import { View, StyleSheet, ActivityIndicator, TouchableOpacity, FlatList } from "react-native";
import { Appbar, Text, Card, IconButton, Portal, Modal, TextInput, Snackbar, SegmentedButtons } from "react-native-paper";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import apiClient from "../../src/api/client";
import { EmployeeAdmin } from "../../src/types";
import { t } from "../../src/i18n";
import { getAdminPin, clearAdminPin } from "../../src/services/adminAuth";
import BaanCodesAdmin from "../../src/components/BaanCodesAdmin";
import LabelReprintAdmin from "../../src/components/LabelReprintAdmin";

/**
 * The hidden employee-admin screen — reached only via a long-press + PIN
 * on the Stats tab (see app/(tabs)/stats.tsx). Every request here carries
 * the PIN entered there as X-Admin-Pin, held in memory by adminAuth (never
 * a route param — on the web build that would leak into the address bar
 * and browser history). There's no persisted "unlocked" state: a page
 * refresh (web) or reopening this screen always needs the PIN again, and
 * going back clears it explicitly too.
 */
export default function EmployeeAdminScreen() {
    const router = useRouter();
    const pin = getAdminPin();
    const queryClient = useQueryClient();
    const [snackbar, setSnackbar] = useState({ visible: false, message: "" });

    // Direct navigation here (a stale web bookmark/back-forward after the
    // in-memory PIN was cleared) has nothing to authenticate with — bounce
    // back to Stats instead of firing a request that can only 401.
    useEffect(() => {
        if (!pin) {
            router.replace("/stats");
        }
    }, [pin, router]);

    const goBack = () => {
        clearAdminPin();
        router.back();
    };

    const authHeaders = { "X-Admin-Pin": pin ?? "" };

    // Three tabs: the employees in every "who did this" picker, the quality
    // engineers who sign off QC with their own PIN (same endpoint shape
    // under a different base, plus a PIN), and the prep checklist's BAAN
    // code list — that one is its own panel (BaanCodesAdmin), not a name list —
    // and reprinting an order's box labels (LabelReprintAdmin).
    const [kind, setKind] = useState<"employees" | "engineers" | "baan" | "labels">("employees");
    const isEngineers = kind === "engineers";
    // The two panels that aren't a name list.
    const isPanel = kind === "baan" || kind === "labels";
    const base = isEngineers ? "/employees/admin/quality-engineers" : "/employees/admin";

    const { data: employees, isLoading, isError } = useQuery<EmployeeAdmin[]>({
        queryKey: ["employees-admin", kind, pin],
        queryFn: async () => (await apiClient.get(base, { headers: authHeaders })).data,
        enabled: !!pin && !isPanel,
    });

    const onError = (error: any) => {
        const msg = error?.response?.data?.error || error.message;
        setSnackbar({ visible: true, message: msg });
    };
    const onMutated = () => queryClient.invalidateQueries({ queryKey: ["employees-admin", kind, pin] });

    // `pin` in the body is the engineer's QC PIN (engineers only) — distinct
    // from the admin PIN in the header.
    const createEntry = useMutation({
        mutationFn: async (body: { name: string; pin?: string }) =>
            (await apiClient.post(base, body, { headers: authHeaders })).data,
        onSuccess: onMutated,
        onError,
    });
    const updateEntry = useMutation({
        mutationFn: async ({ id, ...body }: { id: number; name: string; pin?: string }) =>
            (await apiClient.put(`${base}/${id}`, body, { headers: authHeaders })).data,
        onSuccess: onMutated,
        onError,
    });
    const setActive = useMutation({
        mutationFn: async ({ id, active }: { id: number; active: boolean }) =>
            (await apiClient.post(`${base}/${id}/${active ? "restore" : "hide"}`, {}, { headers: authHeaders }))
                .data,
        onSuccess: onMutated,
        onError,
    });

    // Shared "create" / "edit" modal — editingId null means create-mode.
    const [nameModalVisible, setNameModalVisible] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [nameInput, setNameInput] = useState("");
    const [qcPinInput, setQcPinInput] = useState("");

    const openCreateModal = () => {
        setEditingId(null);
        setNameInput("");
        setQcPinInput("");
        setNameModalVisible(true);
    };
    const openRenameModal = (emp: EmployeeAdmin) => {
        setEditingId(emp.id);
        setNameInput(emp.name);
        setQcPinInput("");
        setNameModalVisible(true);
    };
    const closeNameModal = () => setNameModalVisible(false);
    // An engineer needs a PIN when created; on edit an empty PIN keeps theirs.
    const pinMissing = isEngineers && editingId === null && !qcPinInput;
    const saveName = () => {
        const trimmed = nameInput.trim();
        if (!trimmed || pinMissing) return;
        const pinPart = isEngineers && qcPinInput ? { pin: qcPinInput } : {};
        if (editingId === null) {
            createEntry.mutate({ name: trimmed, ...pinPart });
        } else {
            updateEntry.mutate({ id: editingId, name: trimmed, ...pinPart });
        }
        closeNameModal();
    };
    const savingName = createEntry.isPending || updateEntry.isPending;

    return (
        <View style={styles.container}>
            <Appbar.Header>
                <Appbar.BackAction onPress={goBack} />
                <Appbar.Content title={t("admin.title")} />
                {!isPanel && <Appbar.Action icon="plus" onPress={openCreateModal} />}
            </Appbar.Header>

            <SegmentedButtons
                value={kind}
                onValueChange={(v) => setKind(v as "employees" | "engineers" | "baan" | "labels")}
                style={styles.kindToggle}
                buttons={[
                    { value: "employees", label: t("admin.employeesTab") },
                    { value: "engineers", label: t("admin.engineersTab") },
                    { value: "baan", label: t("admin.baanTab") },
                    { value: "labels", label: t("admin.labelsTab") },
                ]}
            />

            {kind === "labels" && pin && (
                <LabelReprintAdmin
                    authHeaders={authHeaders}
                    onMessage={(message) => setSnackbar({ visible: true, message })}
                />
            )}

            {kind === "baan" && pin && (
                <BaanCodesAdmin
                    authHeaders={authHeaders}
                    onMessage={(message) => setSnackbar({ visible: true, message })}
                />
            )}

            {!isPanel && isLoading && (
                <View style={styles.center}>
                    <ActivityIndicator size="large" />
                </View>
            )}
            {!isPanel && isError && (
                <View style={styles.center}>
                    <Text>{t("admin.loadError")}</Text>
                </View>
            )}

            {!isPanel && !isLoading && !isError && (
                <FlatList
                    data={employees}
                    keyExtractor={(item) => String(item.id)}
                    contentContainerStyle={styles.list}
                    ListEmptyComponent={
                        <View style={styles.center}>
                            <Text>{t("admin.empty")}</Text>
                        </View>
                    }
                    renderItem={({ item }) => (
                        <Card style={[styles.card, !item.active && styles.cardHidden]}>
                            <Card.Content style={styles.row}>
                                <View style={{ flex: 1 }}>
                                    <Text
                                        variant="titleMedium"
                                        style={!item.active && styles.hiddenText}>
                                        {item.name}
                                    </Text>
                                    {!item.active && (
                                        <Text variant="bodySmall" style={styles.hiddenBadge}>
                                            {t("admin.hidden")}
                                        </Text>
                                    )}
                                </View>
                                <IconButton icon="pencil" onPress={() => openRenameModal(item)} />
                                <IconButton
                                    icon={item.active ? "eye-off" : "eye"}
                                    onPress={() => setActive.mutate({ id: item.id, active: !item.active })}
                                />
                            </Card.Content>
                        </Card>
                    )}
                />
            )}

            <Portal>
                <Modal visible={nameModalVisible} onDismiss={closeNameModal} contentContainerStyle={styles.modal}>
                    <Text variant="titleLarge" style={{ marginBottom: 12 }}>
                        {isEngineers ?
                            editingId === null ?
                                t("admin.addEngineer")
                            :   t("admin.editEngineer")
                        : editingId === null ?
                            t("admin.addEmployee")
                        :   t("admin.renameEmployee")}
                    </Text>
                    <TextInput
                        mode="outlined"
                        label={t("admin.name")}
                        value={nameInput}
                        onChangeText={setNameInput}
                        autoFocus
                        onSubmitEditing={saveName}
                    />
                    {isEngineers && (
                        <>
                            <TextInput
                                mode="outlined"
                                label={t("admin.engineerPin")}
                                value={qcPinInput}
                                onChangeText={setQcPinInput}
                                secureTextEntry
                                keyboardType="number-pad"
                                style={{ marginTop: 12 }}
                                onSubmitEditing={saveName}
                            />
                            <Text variant="bodySmall" style={{ color: "#666", marginTop: 4 }}>
                                {editingId === null ? t("admin.engineerPinHint") : t("admin.engineerPinKeepHint")}
                            </Text>
                        </>
                    )}
                    <TouchableOpacity
                        style={[
                            styles.confirmBtn,
                            (!nameInput.trim() || pinMissing || savingName) && styles.confirmBtnDisabled,
                        ]}
                        activeOpacity={0.8}
                        disabled={!nameInput.trim() || pinMissing || savingName}
                        onPress={saveName}>
                        {savingName ?
                            <ActivityIndicator size="small" color="#fff" />
                        :   <Text style={styles.confirmBtnText}>{t("admin.save")}</Text>}
                    </TouchableOpacity>
                </Modal>
            </Portal>

            <Snackbar
                visible={snackbar.visible}
                onDismiss={() => setSnackbar({ visible: false, message: "" })}
                duration={4000}>
                {snackbar.message}
            </Snackbar>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#fff" },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
    list: { padding: 12, flexGrow: 1 },
    kindToggle: { marginHorizontal: 12, marginTop: 12 },
    card: { marginBottom: 8 },
    cardHidden: { opacity: 0.6 },
    row: { flexDirection: "row", alignItems: "center" },
    hiddenText: { color: "#999" },
    hiddenBadge: { color: "#c62828" },
    modal: { backgroundColor: "#fff", marginHorizontal: 24, borderRadius: 16, padding: 24 },
    confirmBtn: {
        backgroundColor: "#ff5100",
        borderRadius: 10,
        paddingVertical: 16,
        alignItems: "center",
        marginTop: 16,
    },
    confirmBtnDisabled: { backgroundColor: "#f0c4a8" },
    confirmBtnText: { color: "#fff", fontWeight: "bold", fontSize: 16 },
});

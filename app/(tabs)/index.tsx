import React, { useState, useCallback, useLayoutEffect, useMemo, useEffect } from "react";
import { FlatList, View, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { Card, Text, Chip, Divider, Snackbar } from "react-native-paper";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useFocusEffect, useRouter, useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import apiClient from "../../src/api/client";
import socket from "../../src/services/socket";
import { Workstation } from "../../src/types";
import { t } from "../../src/i18n";
import LanguageSwitcher from "../../src/components/LanguageSwitcher";

export default function WorkstationsScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const [snackbar, setSnackbar] = useState({ visible: false, message: "" });
    const [lockWarning, setLockWarning] = useState<string | null>(null);

    const {
        data: workstations,
        isLoading,
        isError,
        refetch,
        isRefetching,
    } = useQuery<Workstation[]>({
        queryKey: ["workstations"],
        queryFn: async () => {
            const response = await apiClient.get("/workstations");
            return response.data;
        },
    });

    useFocusEffect(
        useCallback(() => {
            refetch();
        }, [refetch]),
    );

    // Live refresh: cycle_index/total_cycles only get updated on the
    // backend by STARTED/FINISHED order-update calls (the polling feed
    // that GET /workstations mostly reflects doesn't carry cycle info at
    // all) — so without this, the card would show stale cycle progress
    // until the next scheduled poll tick or a manual pull-to-refresh.
    useEffect(() => {
        const onOrderUpdate = () => refetch();
        // PTL started an order that's locked in MasterPlan.
        const onLocked = (e: { workplace: string; projectNumber: string; position: string }) =>
            setLockWarning(
                t("workstations.lockedStarted", { workplace: e.workplace, project: e.projectNumber, position: e.position }),
            );
        socket.on("workstation-order-update", onOrderUpdate);
        socket.on("workstations-updated", onOrderUpdate);
        socket.on("order-locked", onLocked);
        return () => {
            socket.off("workstation-order-update", onOrderUpdate);
            socket.off("workstations-updated", onOrderUpdate);
            socket.off("order-locked", onLocked);
        };
    }, [refetch]);

    const importPbom = useMutation({
        mutationFn: async (order: NonNullable<Workstation["current_order_data"]>) => {
            const response = await apiClient.post("/workstations/import-pbom", {
                projectNumber: order.projectNumber || order.salesOrder,
                position: order.position,
                customer: order.customer,
                productOrder: order.productOrder,
                productDesc: order.productDesc,
                workplace: order.workplace,
            });
            return response.data;
        },
        onSuccess: (doc) => {
            const rev = doc.revisions?.[0];
            router.push({
                pathname: `/document/${doc.id}`,
                params: {
                    filename: rev?.filename || "",
                    version: rev?.version || 1,
                    annotations: rev?.annotations || "",
                },
            });
        },
        onError: () => {
            setSnackbar({ visible: true, message: t("workstations.error") });
        },
    });

    const sorted = useMemo(() => workstations?.slice().sort((a, b) => a.name.localeCompare(b.name)), [workstations]);

    useLayoutEffect(() => {
        navigation.setOptions({
            headerRight: () => (
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <TouchableOpacity onPress={() => router.push("/kiosk")} style={{ marginRight: 16 }}>
                        <Ionicons name="tablet-landscape-outline" size={22} color="#ff5100" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => refetch()} disabled={isRefetching} style={{ marginRight: 16 }}>
                        {isRefetching ?
                            <ActivityIndicator size="small" color="#ff5100" />
                        :   <Ionicons name="refresh" size={22} color="#ff5100" />}
                    </TouchableOpacity>
                    <LanguageSwitcher />
                </View>
            ),
        });
    }, [navigation, refetch, isRefetching, router]);

    if (isLoading && !isRefetching) {
        return (
            <View style={styles.center}>
                <ActivityIndicator size="large" />
            </View>
        );
    }

    if (isError) {
        return (
            <View style={styles.center}>
                <Text variant="titleMedium">{t("workstations.error")}</Text>
                <TouchableOpacity
                    style={[styles.pillBtn, styles.pillBtnPrimary]}
                    activeOpacity={0.8}
                    onPress={() => refetch()}>
                    <Text style={styles.pillBtnText}>{t("workstations.retry")}</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {sorted && sorted.length > 0 ?
                <FlatList
                    data={sorted}
                    keyExtractor={(item) => item.id.toString()}
                    onRefresh={refetch}
                    refreshing={isRefetching}
                    contentContainerStyle={styles.list}
                    renderItem={({ item }) => (
                        <TouchableOpacity
                            onPress={() => {
                                if (item.current_order_data) {
                                    importPbom.mutate(item.current_order_data);
                                }
                            }}
                            disabled={importPbom.isPending}
                            activeOpacity={0.7}>
                            <Card
                                style={[
                                    styles.card,
                                    item.current_order_id && { borderColor: "#ff5100" },
                                    item.locked && styles.cardLocked,
                                ]}
                                mode="outlined">
                                <Card.Title
                                    title={item.name}
                                    titleStyle={styles.cardTitle}
                                    right={(props) => (
                                        <Chip
                                            mode="flat"
                                            compact
                                            style={{
                                                backgroundColor: item.current_order_id ? "#ff5100" : "#e0e0e0",
                                                marginRight: 12,
                                            }}
                                            textStyle={{
                                                color: item.current_order_id ? "#fff" : "#666",
                                                fontSize: 12,
                                            }}>
                                            {item.current_order_id ? t("workstations.busy") : t("workstations.free")}
                                        </Chip>
                                    )}
                                />
                                {item.current_order_data ?
                                    <Card.Content>
                                        <Divider style={{ marginBottom: 12 }} />
                                        {item.locked && (
                                            <View style={styles.lockedBanner}>
                                                <Ionicons name="lock-closed" size={16} color="#c62828" />
                                                <Text variant="bodyMedium" style={styles.lockedBannerText}>
                                                    {t("workstations.locked")}
                                                </Text>
                                            </View>
                                        )}
                                        <Text variant="titleMedium">{item.current_order_data.productDesc}</Text>
                                        {item.current_order_data.type ?
                                            <View style={styles.detailRow}>
                                                <Text variant="bodySmall" style={styles.label}>
                                                    {t("workstations.label.type")}
                                                </Text>
                                                <Text variant="bodySmall" style={styles.value} numberOfLines={1}>
                                                    {t(`workstations.type.${item.current_order_data.type}`, {
                                                        defaultValue: item.current_order_data.type,
                                                    })}
                                                </Text>
                                            </View>
                                        :   null}
                                        {item.current_order_data.salesOrder ?
                                            <View style={styles.detailRow}>
                                                <Text variant="bodySmall" style={styles.label}>
                                                    {t("workstations.label.salesOrder")}
                                                </Text>
                                                <Text variant="bodySmall" style={styles.value} numberOfLines={1}>
                                                    {item.current_order_data.salesOrder}
                                                </Text>
                                            </View>
                                        :   null}
                                        {item.current_order_data.projectNumber ?
                                            <View style={styles.detailRow}>
                                                <Text variant="bodySmall" style={styles.label}>
                                                    {t("workstations.label.project")}
                                                </Text>
                                                <Text variant="bodySmall" style={styles.value} numberOfLines={1}>
                                                    {item.current_order_data.projectNumber}
                                                </Text>
                                            </View>
                                        :   null}
                                        {item.current_order_data.position ?
                                            <View style={styles.detailRow}>
                                                <Text variant="bodySmall" style={styles.label}>
                                                    {t("workstations.label.position")}
                                                </Text>
                                                <Text variant="bodySmall" style={styles.value}>
                                                    {item.current_order_data.position}
                                                </Text>
                                            </View>
                                        :   null}
                                        {item.current_order_data.customerDesc ?
                                            <View style={styles.detailRow}>
                                                <Text variant="bodySmall" style={styles.label}>
                                                    {t("workstations.label.customer")}
                                                </Text>
                                                <Text variant="bodySmall" style={styles.value} numberOfLines={1}>
                                                    {item.current_order_data.customerDesc}
                                                </Text>
                                            </View>
                                        :   null}
                                        <View style={styles.detailRow}>
                                            <Text variant="bodySmall" style={styles.label}>
                                                {t("workstations.label.cycle")}
                                            </Text>
                                            <Text variant="bodySmall" style={styles.value}>
                                                {t("workstations.cycleValue", {
                                                    current: item.cycle_index ?? 1,
                                                    total: item.total_cycles ?? 1,
                                                })}
                                            </Text>
                                        </View>
                                    </Card.Content>
                                :   <Card.Content>
                                        <Text variant="bodyMedium" style={{ color: "#999" }}>
                                            {t("workstations.noOrder")}
                                        </Text>
                                    </Card.Content>
                                }
                            </Card>
                        </TouchableOpacity>
                    )}
                />
            :   <View style={styles.center}>
                    <Text variant="bodyLarge">{t("workstations.empty")}</Text>
                    <TouchableOpacity
                        style={[styles.pillBtn, styles.pillBtnPrimary]}
                        activeOpacity={0.8}
                        onPress={() => refetch()}
                        disabled={isRefetching}>
                        {isRefetching ?
                            <ActivityIndicator size="small" color="#fff" />
                        :   <Text style={styles.pillBtnText}>{t("workstations.refresh")}</Text>}
                    </TouchableOpacity>
                </View>
            }
            <Snackbar visible={snackbar.visible} onDismiss={() => setSnackbar({ ...snackbar, visible: false })}>
                {snackbar.message}
            </Snackbar>
            <Snackbar
                visible={!!lockWarning}
                onDismiss={() => setLockWarning(null)}
                duration={30000}
                style={styles.lockWarning}
                action={{ label: "OK", textColor: "#fff", onPress: () => setLockWarning(null) }}>
                {lockWarning}
            </Snackbar>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#fff" },
    center: { flex: 1, justifyContent: "center", alignItems: "center" },
    list: { padding: 12 },
    card: { marginBottom: 12 },
    cardLocked: { borderColor: "#c62828", borderWidth: 2 },
    lockedBanner: {
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: "#ffebee",
        borderRadius: 6,
        padding: 8,
        marginBottom: 8,
    },
    lockedBannerText: { color: "#c62828", fontWeight: "600", flex: 1 },
    lockWarning: { backgroundColor: "#c62828" },
    cardTitle: { fontWeight: "bold" },
    detailRow: { flexDirection: "row", marginTop: 4 },
    label: { fontWeight: "600", width: 100, color: "#666" },
    value: { flex: 1 },
    pillBtn: {
        marginTop: 20,
        borderRadius: 20,
        paddingHorizontal: 24,
        height: 40,
        justifyContent: "center",
        alignItems: "center",
    },
    pillBtnPrimary: {
        backgroundColor: "#ff5100",
    },
    pillBtnText: {
        color: "#fff",
        fontSize: 14,
        fontWeight: "600",
    },
});

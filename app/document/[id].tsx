import React, { useState, useCallback, useEffect, useRef } from "react";
import { View, StyleSheet, ActivityIndicator, Platform, TouchableOpacity, ScrollView } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Appbar, Snackbar, Portal, Modal, Text, TextInput } from "react-native-paper";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import { Asset } from "expo-asset";
import { readAsStringAsync } from "expo-file-system/legacy";
import apiClient, { BASE_URL, API_KEY } from "../../src/api/client";
import { t } from "../../src/i18n";
import {
    CompletionContext,
    CompletionStatus,
    CheckStatus,
    CycleCheck,
    QcCycleCheck,
    OrderHistoryEvent,
} from "../../src/types";
import CycleHistory from "../../src/components/CycleHistory";
import QcCheckModal from "../../src/components/QcCheckModal";
import AdminPinModal from "../../src/components/AdminPinModal";
import ManualCompletionModal from "../../src/components/ManualCompletionModal";
import { useEmployees } from "../../src/hooks/useEmployees";
import EmployeePicker from "../../src/components/EmployeePicker";
import PrepLabelModal, { usePrepLabelStatus } from "../../src/components/PrepLabelModal";
import { saveEditedPdfWithRetry, PendingSave } from "../../src/utils/saveEditedPdf";

interface DocumentMeta {
    project_number: string | null;
    position: string | null;
    status: CompletionStatus | null;
    revisioned: boolean;
    checked: boolean;
    checked_cycles: number;
    total_cycles: number;
    unchecked_cycles: number[];
    cycles: CycleCheck[];
    completion: CompletionContext | null;
    // Quality-control sign-off (TMP 00000040 = "j") — separate from the
    // standard check above; done by quality engineers with their own PIN.
    qc_required: boolean | null;
    qc_checked: boolean;
    qc_checked_cycles: number;
    qc_cycles: QcCycleCheck[];
    // Every preparation / completion / check / QC round, oldest first.
    history: OrderHistoryEvent[];
}

// Every completion status EXCEPT "complete" itself — none of these close
// the order in the ERP (TOORS) right away (see completionController.ts:
// only status "complete" triggers closeOrderInToors). The "Finish order"
// action re-submits the completion as "complete" so it does.
const NON_COMPLETE_STATUSES: CompletionStatus[] = [
    "complete_with_changes",
    "missing_product",
    "shipped_incomplete",
];

export default function DocumentViewerScreen() {
    const { id, filename, fromPrepQueue } = useLocalSearchParams();
    const router = useRouter();
    const webViewRef = useRef<WebView>(null);
    const [mode, setMode] = useState<"view" | "edit">("view");
    const [loading, setLoading] = useState(false);
    const [snackbar, setSnackbar] = useState({ visible: false, message: "" });
    const [refreshKey, setRefreshKey] = useState(0);
    const [editSrc, setEditSrc] = useState<string | null>(null);
    const [editHtml, setEditHtml] = useState<string | null>(null);
    const blobUrlRef = useRef<string | null>(null);
    // Set when a save fails after exhausting all retries — keeps the
    // edited PDF bytes around so the worker can retry from the snackbar
    // instead of losing the edit and having to redo it from scratch.
    const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);

    const retrySave = useCallback(async () => {
        if (!pendingSave) return;
        setSnackbar({ visible: true, message: t("document.saving") });
        try {
            await saveEditedPdfWithRetry(pendingSave);
            setPendingSave(null);
            setSnackbar({ visible: true, message: t("document.saved") });
            setRefreshKey((k) => k + 1);
            setMode("view");
            setEditSrc(null);
            setEditHtml(null);
        } catch (err: any) {
            setSnackbar({
                visible: true,
                message: err?.response?.data?.error || err?.message || t("document.editorError"),
            });
        }
    }, [pendingSave]);

    // ── prep-station "print label" action ──
    // Needs this document's projectNumber/position, which the route params
    // don't carry — fetched from its own record.
    // Declared before docMeta: while either check dialog is open, docMeta is
    // re-read every few seconds — several people check cycles of the same
    // order at once, and each must see the others' checks as they happen.
    const [checkModalVisible, setCheckModalVisible] = useState(false);
    const [qcModalVisible, setQcModalVisible] = useState(false);
    const { data: docMeta, refetch: refetchDocMeta } = useQuery({
        queryKey: ["document-meta", id],
        queryFn: async () => {
            const response = await apiClient.get(`/files/${id}`);
            return response.data as DocumentMeta;
        },
        refetchInterval: checkModalVisible || qcModalVisible ? 4000 : false,
    });
    // The first prep-label print is only reachable from the
    // preparation queue tab (see app/(tabs)/prep-queue.tsx) — a worker
    // opens the BOM from there specifically to review what to prepare
    // before printing, so it must not be offered when a document is opened
    // any other way (search, revisions overview, etc). fromPrepQueue is set
    // in the route params only by that screen's navigation.
    // Once printed, the order leaves the queue — so an already printed
    // label stays reachable from the document opened any way, where the
    // dialog offers reprinting chosen doors (see PrepLabelModal).
    const { data: prepLabelStatus } = usePrepLabelStatus(
        docMeta?.project_number ?? "",
        docMeta?.position ?? "",
        !!docMeta,
    );
    const canPrintLabel =
        (fromPrepQueue === "1" || !!prepLabelStatus?.printed) && !!(docMeta?.project_number && docMeta?.position);

    // ── "Check" (QC) action ──
    // Only offered once the order has actually reached one of the kiosk
    // finishing states (complete, complete_with_changes, missing_product,
    // shipped_incomplete) — before that there's nothing to check yet, so
    // showing "unchecked" or a Check button would be misleading rather
    // than useful. docMeta.status is null until the kiosk records a
    // completion for this project/position (see completionService.ts).
    const canCheck = !!(docMeta?.project_number && docMeta?.position && docMeta?.status);

    // ── Quality-control sign-off ──
    // Its own action, on every finished order (any completion status —
    // same gate as the standard check); orders whose TMP file asks for QC
    // are just highlighted (qcAction's colour, the Docs tab's QC filter).
    // The quality engineer unlocks it with their personal PIN — see
    // QcCheckModal.
    const canQcCheck = canCheck && !!docMeta?.completion?.workstation;

    // ── Manual completion (hidden) ──
    // For orders that can't be completed through P2L: long-press the
    // document title → admin PIN → a kiosk-like completion with only the
    // non-"complete" statuses (see ManualCompletionModal). The verified PIN
    // lives only in this state while the modal is open.
    const canManualComplete = !!(docMeta?.project_number && docMeta?.position);
    const [manualPinVisible, setManualPinVisible] = useState(false);
    const [manualPin, setManualPin] = useState<string | null>(null);

    // ── "Finish order" action ──
    // Offered from inside an opened document (edited or not) whose order
    // was closed as anything other than "complete", so a "bad" state can be
    // turned into "complete" — not from the overview list.
    const canFinishOrder =
        !!docMeta &&
        !!docMeta.status &&
        NON_COMPLETE_STATUSES.includes(docMeta.status) &&
        !!docMeta.completion;

    const queryClient = useQueryClient();
    const [finishModalVisible, setFinishModalVisible] = useState(false);
    const [finishSelectedEmployee, setFinishSelectedEmployee] = useState<string | null>(null);
    const { data: finishEmployees } = useEmployees(finishModalVisible);

    const finishOrder = useMutation({
        mutationFn: async () => {
            if (!docMeta?.completion || !finishSelectedEmployee) return;
            const c = docMeta.completion;
            await apiClient.post("/workstations/order-completion", {
                orderId: c.order_id,
                workstation: c.workstation,
                cycleIndex: c.cycle_index,
                totalCycles: c.total_cycles,
                productOrder: c.product_order,
                projectNumber: docMeta.project_number,
                position: docMeta.position,
                salesOrder: c.sales_order,
                employeeName: finishSelectedEmployee,
                status: "complete",
            });
        },
        onSuccess: () => {
            setFinishModalVisible(false);
            setFinishSelectedEmployee(null);
            setSnackbar({ visible: true, message: t("document.finishSuccess") });
            queryClient.invalidateQueries({ queryKey: ["document-meta", id] });
            queryClient.invalidateQueries({ queryKey: ["documents-overview"] });
        },
        onError: (error: any) => {
            const msg = error?.response?.data?.error || error.message;
            setSnackbar({ visible: true, message: t("document.finishError", { msg }) });
        },
    });

    const [labelPickerVisible, setLabelPickerVisible] = useState(false);

    // ── "Check" action (QC) ──
    // Records the third role on a cycle: who verified it's actually
    // correct, alongside who prepared it (order_preparation_log) and who
    // ran it (order_completion_log). Checking is per cycle (one box at a
    // time, mirroring how one Prepare prints a separate label per box) —
    // the picker below lists every cycle from docMeta.cycles with its
    // current status so a worker can see at a glance which boxes still
    // need checking and pick one. Available generally whenever a document
    // has a project/position — there's no dedicated QC queue tab yet
    // (unlike prep labels, which are deliberately restricted to the
    // prep-queue flow), so this stays reachable from wherever a document is
    // opened.
    const [checkSelectedEmployee, setCheckSelectedEmployee] = useState<string | null>(null);
    const [selectedCycleIndex, setSelectedCycleIndex] = useState<number | null>(null);
    const [checkStatusChoice, setCheckStatusChoice] = useState<CheckStatus>("ok");
    const [checkNote, setCheckNote] = useState("");
    const { data: checkEmployees } = useEmployees(checkModalVisible);

    // Cycles already checked when the dialog opened. A cycle checked by
    // someone else WHILE it's open is "checked meanwhile": the dialog says
    // who did it and confirming it again has to be deliberate.
    const [checkedAtOpen, setCheckedAtOpen] = useState<Set<number>>(new Set());

    const openCheckModal = async () => {
        setCheckModalVisible(true);
        // Fresh data first — someone may have checked a cycle seconds ago.
        const cycles = (await refetchDocMeta()).data?.cycles ?? docMeta?.cycles ?? [];
        setCheckedAtOpen(new Set(cycles.filter((c) => c.checked).map((c) => c.cycleIndex)));
        // Default to the first still-unchecked cycle so the common case
        // (checking off boxes one by one) needs no extra taps — falls back
        // to cycle 1 if everything's already checked (re-checking is
        // allowed).
        const firstUnchecked = cycles.find((c) => !c.checked);
        setSelectedCycleIndex(firstUnchecked?.cycleIndex ?? cycles[0]?.cycleIndex ?? 1);
    };

    const selectedCycle = docMeta?.cycles?.find((c) => c.cycleIndex === selectedCycleIndex);
    const checkedMeanwhile =
        !!selectedCycle?.checked && selectedCycleIndex !== null && !checkedAtOpen.has(selectedCycleIndex);

    const closeCheckModal = () => {
        setCheckModalVisible(false);
        setCheckSelectedEmployee(null);
        setSelectedCycleIndex(null);
        setCheckStatusChoice("ok");
        setCheckNote("");
    };

    const submitCheck = useMutation({
        // sawNotice: the "checked meanwhile" notice was on screen when the
        // button was pressed, so a re-check is what the user wants.
        mutationFn: async (sawNotice: boolean) => {
            if (
                !docMeta?.project_number ||
                !docMeta?.position ||
                !docMeta?.completion?.workstation ||
                !checkSelectedEmployee ||
                !selectedCycleIndex
            )
                return;
            // Last-moment check: if someone checked this cycle in the
            // seconds since the last refresh, don't record it twice — the
            // refreshed dialog now shows who did.
            if (!sawNotice && !checkedAtOpen.has(selectedCycleIndex)) {
                const fresh = (await refetchDocMeta()).data?.cycles?.find((c) => c.cycleIndex === selectedCycleIndex);
                if (fresh?.checked) {
                    throw Object.assign(
                        new Error(t("document.checkedMeanwhile", { cycle: selectedCycleIndex, name: fresh.employeeName ?? "?" })),
                        { meanwhile: true },
                    );
                }
            }
            await apiClient.post("/workstations/order-check", {
                projectNumber: docMeta.project_number,
                position: docMeta.position,
                // The same position can be completed independently at more
                // than one workplace (Hardware/Motor) — this keeps the
                // check scoped to the one this document actually belongs
                // to, instead of being conflated with another's.
                workstation: docMeta.completion.workstation,
                cycleIndex: selectedCycleIndex,
                totalCycles: docMeta.total_cycles,
                employeeName: checkSelectedEmployee,
                status: checkStatusChoice,
                note: checkNote.trim() || undefined,
            });
        },
        onSuccess: () => {
            closeCheckModal();
            setSnackbar({ visible: true, message: t("document.checkSuccess") });
            queryClient.invalidateQueries({ queryKey: ["document-meta", id] });
            queryClient.invalidateQueries({ queryKey: ["documents-overview"] });
        },
        onError: (error: any) => {
            if (error?.meanwhile) return setSnackbar({ visible: true, message: error.message });
            const msg = error?.response?.data?.error || error.message;
            setSnackbar({ visible: true, message: t("document.checkError", { msg }) });
        },
    });

    useEffect(() => {
        if (mode !== "edit" && blobUrlRef.current) {
            URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = null;
        }
    }, [mode]);

    useEffect(() => {
        return () => {
            if (blobUrlRef.current) {
                URL.revokeObjectURL(blobUrlRef.current);
                blobUrlRef.current = null;
            }
        };
    }, []);

    // A WebView (native) / <iframe> (web) loads this URL directly and can't
    // attach a custom X-API-Key header, so the shared key is passed as a
    // query param instead — the one exception the backend's apiKeyAuth
    // middleware allows, and it's redacted from server logs.
    const pdfUrl = `${BASE_URL}/workstations/documents/${id}/render?t=${refreshKey}&apiKey=${encodeURIComponent(API_KEY ?? "")}`;

    // ── handle "edit" press ──
    const handleEdit = useCallback(async () => {
        setLoading(true);
        try {
            // Fetch PDF as base64
            const res = await apiClient.get(`/workstations/documents/${id}/render`, {
                responseType: "arraybuffer",
            });
            const pdfBytes = new Uint8Array(res.data);
            let binary = "";
            const chunk = 8192;
            for (let i = 0; i < pdfBytes.length; i += chunk) {
                binary += String.fromCharCode(...pdfBytes.slice(i, i + chunk));
            }
            const pdfBase64 = btoa(binary);

            if (Platform.OS === "web") {
                // ── Web: embed editor in-page via blob URL iframe ──
                const editorRes = await fetch(`/editor/index.html`);
                let html = await editorRes.text();

                const patch = `
<script>
window.__INLINE_MODE__=true;
window.__INLINE_PDF_DATA__="${pdfBase64}";
window.__INLINE_FILE_NAME__="${filename}";
window.ReactNativeWebView={postMessage:function(m){window.parent.postMessage(JSON.parse(m),"*")}};
</script>`;
                html = html.replace("</head>", patch + "</head>");
                if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
                const blob = new Blob([html], { type: "text/html" });
                blobUrlRef.current = URL.createObjectURL(blob);
                setEditSrc(blobUrlRef.current);
                setMode("edit");
            } else {
                // ── Native: read asset, patch PDF inline, use source={{ html }} ──
                const asset = Asset.fromModule(require("../../assets/editor/index.html"));
                await asset.downloadAsync();
                let html = await readAsStringAsync(asset.localUri!);
                const patch = `<script>window.__INLINE_MODE__=true;window.__INLINE_PDF_DATA__="${pdfBase64}";window.__INLINE_FILE_NAME__="${filename}";</script>`;
                html = html.replace("</head>", patch + "</head>");
                setEditHtml(html);
                setMode("edit");
            }
        } catch (err: any) {
            const msg = err?.message || t("document.editorError");
            setSnackbar({ visible: true, message: msg });
        } finally {
            setLoading(false);
        }
    }, [id, filename]);

    // ── listen for SAVED from editor (web iframe or window.open) ──
    useEffect(() => {
        if (Platform.OS !== "web") return;
        const handler = async (e: MessageEvent) => {
            if (e.data?.type !== "SAVED") return;
            const pdfBase64 = e.data.pdfBase64;
            if (pdfBase64) {
                const save: PendingSave = {
                    documentId: Number(id),
                    pdfBase64,
                    filename: e.data.fileName || filename,
                };
                setSnackbar({ visible: true, message: t("document.saving") });
                try {
                    await saveEditedPdfWithRetry(save);
                    setSnackbar({ visible: true, message: t("document.saved") });
                } catch (err: any) {
                    setPendingSave(save);
                    setSnackbar({
                        visible: true,
                        message: err?.response?.data?.error || err?.message || t("document.editorError"),
                    });
                    return;
                }
            }
            setTimeout(() => {
                setRefreshKey((k) => k + 1);
                setMode("view");
                setEditSrc(null);
            }, 500);
        };
        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, [id, filename]);

    // ── handle SAVED from native WebView ──
    const handleWebViewMessage = useCallback(
        async (event: WebViewMessageEvent) => {
            try {
                const msg = JSON.parse(event.nativeEvent.data);
                if (msg.type === "SAVED") {
                    if (msg.pdfBase64) {
                        const save: PendingSave = {
                            documentId: Number(id),
                            pdfBase64: msg.pdfBase64,
                            filename: msg.fileName || filename,
                        };
                        setSnackbar({ visible: true, message: t("document.saving") });
                        try {
                            await saveEditedPdfWithRetry(save);
                            setSnackbar({ visible: true, message: t("document.saved") });
                        } catch (err: any) {
                            setPendingSave(save);
                            setSnackbar({
                                visible: true,
                                message: err?.response?.data?.error || err?.message || t("document.editorError"),
                            });
                            return;
                        }
                    }
                    setTimeout(() => {
                        setRefreshKey((k) => k + 1);
                        setMode("view");
                        setEditHtml(null);
                    }, 500);
                }
            } catch (err: any) {
                setSnackbar({ visible: true, message: err?.message || t("document.editorError") });
            }
        },
        [id, filename],
    );

    const handleWebViewError = useCallback((event: any) => {
        console.log("WebView error:", event.nativeEvent);
    }, []);

    const employeePickerModal = (
        <PrepLabelModal
            visible={labelPickerVisible}
            onDismiss={() => setLabelPickerVisible(false)}
            projectNumber={docMeta?.project_number ?? ""}
            position={docMeta?.position ?? ""}
            totalCycles={docMeta?.total_cycles ?? 1}
        />
    );

    const finishModal = (
        <Portal>
            <Modal
                visible={finishModalVisible}
                onDismiss={() => setFinishModalVisible(false)}
                contentContainerStyle={styles.modal}>
                <Text variant="titleLarge" style={{ marginBottom: 4 }}>
                    {t("document.finishTitle")}
                </Text>
                <Text variant="bodyMedium" style={{ color: "#666", marginBottom: 16 }}>
                    {t("document.finishHint")}
                </Text>
                <EmployeePicker
                    employees={finishEmployees}
                    selected={finishSelectedEmployee}
                    onSelect={setFinishSelectedEmployee}
                    style={{ marginBottom: 16 }}
                />
                <TouchableOpacity
                    style={[
                        styles.confirmBtn,
                        (!finishSelectedEmployee || finishOrder.isPending) && styles.confirmBtnDisabled,
                    ]}
                    activeOpacity={0.8}
                    disabled={!finishSelectedEmployee || finishOrder.isPending}
                    onPress={() => finishOrder.mutate()}>
                    {finishOrder.isPending ?
                        <ActivityIndicator size="small" color="#fff" />
                    :   <Text style={styles.confirmBtnText}>{t("document.finishConfirm")}</Text>}
                </TouchableOpacity>
            </Modal>
        </Portal>
    );

    // Header title — long-pressing it is the hidden entry to manual
    // completion. TouchableOpacity rather than Text's own onLongPress,
    // which never fires on the web build (react-native-web only times
    // long-presses for Touchable/Pressable).
    const headerTitle =
        mode === "edit" ? t("document.editing")
        : canManualComplete ?
            <TouchableOpacity onLongPress={() => setManualPinVisible(true)} delayLongPress={600}>
                <Text variant="titleLarge" numberOfLines={1}>
                    {filename}
                </Text>
            </TouchableOpacity>
        :   `${filename}`;

    const manualCompletionModals = (
        <>
            <AdminPinModal
                visible={manualPinVisible}
                onDismiss={() => setManualPinVisible(false)}
                onUnlocked={(pin) => {
                    setManualPinVisible(false);
                    setManualPin(pin);
                }}
            />
            {manualPin !== null && docMeta && (
                <ManualCompletionModal
                    visible
                    onDismiss={() => setManualPin(null)}
                    onDone={() => {
                        setManualPin(null);
                        setSnackbar({ visible: true, message: t("manual.success") });
                        queryClient.invalidateQueries({ queryKey: ["document-meta", id] });
                        queryClient.invalidateQueries({ queryKey: ["documents-overview"] });
                    }}
                    documentId={Number(id)}
                    totalCycles={docMeta.total_cycles ?? 1}
                    history={docMeta.history ?? []}
                    adminPin={manualPin}
                />
            )}
        </>
    );

    const qcModal = canQcCheck && docMeta ? (
        <QcCheckModal
            visible={qcModalVisible}
            onDismiss={() => setQcModalVisible(false)}
            onDone={(engineerName) => {
                setQcModalVisible(false);
                setSnackbar({ visible: true, message: t("qc.success", { name: engineerName }) });
                queryClient.invalidateQueries({ queryKey: ["document-meta", id] });
                queryClient.invalidateQueries({ queryKey: ["documents-overview"] });
            }}
            projectNumber={docMeta.project_number ?? ""}
            position={docMeta.position ?? ""}
            workstation={docMeta.completion?.workstation ?? ""}
            totalCycles={docMeta.total_cycles}
            cycles={docMeta.qc_cycles ?? []}
            history={docMeta.history ?? []}
        />
    ) : null;

    // QC action's header icon — green once every cycle is QC-OK, purple
    // while an order that REQUIRES QC (TMP file) still owes it, neutral
    // for an order where QC is optional.
    const qcAction = (
        <Appbar.Action
            icon={docMeta?.qc_checked ? "shield-check" : "shield-lock-outline"}
            color={
                docMeta?.qc_checked ? "#2e7d32"
                : docMeta?.qc_required ? "#6a1b9a"
                : undefined
            }
            onPress={() => setQcModalVisible(true)}
            disabled={loading}
        />
    );

    const checkModal = (
        <Portal>
            <Modal visible={checkModalVisible} onDismiss={closeCheckModal} contentContainerStyle={styles.modal}>
                <Text variant="titleLarge" style={{ marginBottom: 4 }}>
                    {t("document.checkTitle")}
                </Text>
                <Text variant="bodyMedium" style={{ color: "#666", marginBottom: 12 }}>
                    {t("document.checkHint")}
                </Text>

                <Text variant="labelLarge" style={{ marginBottom: 6, color: "#333" }}>
                    {t("document.checkCycleLabel", {
                        checked: docMeta?.checked_cycles ?? 0,
                        total: docMeta?.total_cycles ?? 1,
                    })}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
                    <View style={styles.cycleRow}>
                        {(docMeta?.cycles ?? []).map((cycle) => (
                            <TouchableOpacity
                                key={cycle.cycleIndex}
                                style={[
                                    styles.cyclePill,
                                    cycle.checked && styles.cyclePillChecked,
                                    (cycle.status === "issue" || cycle.awaitingFix) && styles.cyclePillIssue,
                                    selectedCycleIndex === cycle.cycleIndex && styles.cyclePillSelected,
                                ]}
                                activeOpacity={0.8}
                                onPress={() => setSelectedCycleIndex(cycle.cycleIndex)}>
                                <Text
                                    style={[
                                        styles.cyclePillText,
                                        (cycle.checked || cycle.status === "issue" || cycle.awaitingFix) && styles.cyclePillTextLight,
                                    ]}>
                                    {cycle.cycleIndex}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </ScrollView>
                {/* Full history of the selected cycle — every completion,
                    check and QC round with notes, e.g. what QC found that
                    this re-check is now verifying. */}
                {checkedMeanwhile && (
                    <Text variant="bodyMedium" style={{ color: "#c62828", fontWeight: "600", marginBottom: 8 }}>
                        {t("document.checkedMeanwhileNotice", {
                            cycle: selectedCycleIndex,
                            name: selectedCycle?.employeeName ?? "?",
                            time: selectedCycle?.checkedAt ?
                                new Date(selectedCycle.checkedAt).toLocaleTimeString("cs-CZ", {
                                    timeZone: "Europe/Prague",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                })
                            :   "",
                        })}
                    </Text>
                )}
                {docMeta?.cycles?.find((c) => c.cycleIndex === selectedCycleIndex)?.awaitingFix && (
                    <Text variant="bodyMedium" style={{ color: "#c62828", fontWeight: "600", marginBottom: 8 }}>
                        {t("document.checkAwaitingFix")}
                    </Text>
                )}
                {selectedCycleIndex !== null && (
                    <CycleHistory events={docMeta?.history ?? []} cycleIndex={selectedCycleIndex} />
                )}

                <View style={styles.statusToggleRow}>
                    <TouchableOpacity
                        style={[styles.statusToggleBtn, checkStatusChoice === "ok" && styles.statusToggleBtnOkActive]}
                        activeOpacity={0.8}
                        onPress={() => setCheckStatusChoice("ok")}>
                        <Text
                            style={[
                                styles.statusToggleText,
                                checkStatusChoice === "ok" && styles.statusToggleTextActive,
                            ]}>
                            {t("document.checkStatusOk")}
                        </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[
                            styles.statusToggleBtn,
                            checkStatusChoice === "issue" && styles.statusToggleBtnIssueActive,
                        ]}
                        activeOpacity={0.8}
                        onPress={() => setCheckStatusChoice("issue")}>
                        <Text
                            style={[
                                styles.statusToggleText,
                                checkStatusChoice === "issue" && styles.statusToggleTextActive,
                            ]}>
                            {t("document.checkStatusIssue")}
                        </Text>
                    </TouchableOpacity>
                </View>

                <TextInput
                    mode="outlined"
                    placeholder={t("document.checkNotePlaceholder")}
                    value={checkNote}
                    onChangeText={setCheckNote}
                    multiline
                    style={{ marginBottom: 16 }}
                />

                <EmployeePicker
                    employees={checkEmployees}
                    selected={checkSelectedEmployee}
                    onSelect={setCheckSelectedEmployee}
                    style={{ marginBottom: 16 }}
                />
                <TouchableOpacity
                    style={[
                        styles.confirmBtn,
                        checkStatusChoice === "issue" && styles.confirmBtnIssue,
                        (!checkSelectedEmployee || !selectedCycleIndex || submitCheck.isPending) &&
                            styles.confirmBtnDisabled,
                    ]}
                    activeOpacity={0.8}
                    disabled={!checkSelectedEmployee || !selectedCycleIndex || submitCheck.isPending}
                    onPress={() => submitCheck.mutate(checkedMeanwhile)}>
                    {submitCheck.isPending ?
                        <ActivityIndicator size="small" color="#fff" />
                    :   <Text style={styles.confirmBtnText}>
                            {checkedMeanwhile ?
                                t("document.checkConfirmCycleAgain", { cycle: selectedCycleIndex })
                            : selectedCycleIndex ?
                                t("document.checkConfirmCycle", { cycle: selectedCycleIndex })
                            :   t("document.checkConfirm")}
                        </Text>
                    }
                </TouchableOpacity>
            </Modal>
        </Portal>
    );

    if (Platform.OS === "web") {
        return (
            <View style={styles.container}>
                <Appbar.Header>
                    <Appbar.BackAction onPress={() => router.back()} />
                    <Appbar.Content title={headerTitle} />
                    {mode === "view" && canFinishOrder && (
                        <Appbar.Action
                            icon="flag-checkered"
                            color="#2e7d32"
                            onPress={() => setFinishModalVisible(true)}
                            disabled={loading}
                        />
                    )}
                    {mode === "view" && canPrintLabel && (
                        <Appbar.Action icon="printer" onPress={() => setLabelPickerVisible(true)} disabled={loading} />
                    )}
                    {mode === "view" && canQcCheck && qcAction}
                    {mode === "view" && canCheck && (
                        <Appbar.Action
                            icon={docMeta?.checked ? "check-decagram" : "clipboard-check-outline"}
                            color={docMeta?.checked ? "#2e7d32" : undefined}
                            onPress={() => openCheckModal()}
                            disabled={loading}
                        />
                    )}
                    {mode === "view" && <Appbar.Action icon="pencil" onPress={handleEdit} disabled={loading} />}
                </Appbar.Header>
                <View style={styles.viewerContainer}>
                    {mode === "view" ?
                        <iframe
                            src={pdfUrl}
                            style={{ width: "100%", height: "100%", border: "none" }}
                            title={filename as string}
                        />
                    : editSrc ?
                        <iframe
                            src={editSrc}
                            style={{ width: "100%", height: "100%", border: "none" }}
                            title={t("document.iframeTitle")}
                        />
                    :   null}
                </View>
                {loading && (
                    <View style={styles.loadingOverlay}>
                        <ActivityIndicator size="large" color="#fff" />
                    </View>
                )}
                <Snackbar
                    visible={snackbar.visible}
                    onDismiss={() => setSnackbar({ ...snackbar, visible: false })}
                    duration={pendingSave ? 15000 : 4000}
                    action={pendingSave ? { label: t("document.retrySave"), onPress: retrySave } : undefined}>
                    {snackbar.message}
                </Snackbar>
                {employeePickerModal}
                {finishModal}
                {checkModal}
                {qcModal}
                {manualCompletionModals}
            </View>
        );
    }

    // ── native render ──
    return (
        <View style={styles.container}>
            <Appbar.Header>
                <Appbar.BackAction onPress={() => router.back()} />
                <Appbar.Content title={headerTitle} />
                {mode === "view" && canFinishOrder && (
                    <Appbar.Action
                        icon="flag-checkered"
                        color="#2e7d32"
                        onPress={() => setFinishModalVisible(true)}
                        disabled={loading}
                    />
                )}
                {mode === "view" && canPrintLabel && (
                    <Appbar.Action icon="printer" onPress={() => setLabelPickerVisible(true)} disabled={loading} />
                )}
                {mode === "view" && canQcCheck && qcAction}
                {mode === "view" && canCheck && (
                    <Appbar.Action
                        icon={docMeta?.checked ? "check-decagram" : "clipboard-check-outline"}
                        color={docMeta?.checked ? "#2e7d32" : undefined}
                        onPress={() => openCheckModal()}
                        disabled={loading}
                    />
                )}
                {mode === "view" && <Appbar.Action icon="pencil" onPress={handleEdit} disabled={loading} />}
            </Appbar.Header>

            <View style={styles.viewerContainer}>
                {mode === "view" ?
                    <WebView
                        source={{
                            html: getPdfViewerHtml(
                                pdfUrl,
                                filename as string,
                                t("document.viewerLoading"),
                                t("document.viewerError"),
                            ),
                        }}
                        style={{ flex: 1 }}
                        originWhitelist={["*"]}
                        javaScriptEnabled={true}
                        scrollEnabled={true}
                    />
                : editHtml ?
                    <WebView
                        ref={webViewRef}
                        source={{ html: editHtml }}
                        style={{ flex: 1 }}
                        originWhitelist={["*"]}
                        javaScriptEnabled={true}
                        scrollEnabled={true}
                        onMessage={handleWebViewMessage}
                        onError={handleWebViewError}
                    />
                :   null}
                {loading && (
                    <View style={styles.loadingOverlay}>
                        <ActivityIndicator size="large" color="#fff" />
                    </View>
                )}
            </View>

            <Snackbar
                visible={snackbar.visible}
                onDismiss={() => setSnackbar({ ...snackbar, visible: false })}
                duration={pendingSave ? 15000 : 4000}
                action={pendingSave ? { label: t("document.retrySave"), onPress: retrySave } : undefined}>
                {snackbar.message}
            </Snackbar>
            {employeePickerModal}
            {finishModal}
            {checkModal}
            {qcModal}
            {manualCompletionModals}
        </View>
    );
}

function getPdfViewerHtml(url: string, docName: string, loadingText: string, errorPrefix: string) {
    const safeUrl = JSON.stringify(url);
    const safeDocName = docName.replace(/[<>]/g, "");
    const safeLoadingText = loadingText.replace(/[<>]/g, "");
    const safeErrorPrefix = errorPrefix.replace(/[<>]/g, "");
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=3.0">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #525659; font-family: sans-serif; overflow-x: auto; }
    #viewer { width: 100%; }
    .page { display: flex; justify-content: flex-start; margin-bottom: 8px; padding-left: 8px; }
    .page canvas { box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    .error { color: #fff; text-align: center; padding: 40px 20px; font-size: 16px; }
    .loading-wrap { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:60px 20px; gap:16px; }
    .spinner { width:32px; height:32px; border:3px solid rgba(255,255,255,0.15); border-top-color:#ff5100; border-radius:50%; animation:spin .8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .loading-name { color:#aaa; font-size:13px; text-align:center; }
  </style>
</head>
<body>
  <div id="viewer"><div class="loading-wrap"><div class="spinner"></div><div class="loading-name">${safeLoadingText}<br>${safeDocName}</div></div></div>
  <script>
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    pdfjsLib.getDocument(${safeUrl}).promise.then(function(pdf) {
      document.getElementById('viewer').innerHTML = '';
      for (var i = 1; i <= pdf.numPages; i++) {
        (function(pageNum) {
          pdf.getPage(pageNum).then(function(page) {
            var scale = (window.devicePixelRatio || 1) * 1.25;
            var viewport = page.getViewport({ scale: scale });
            var wrapper = document.createElement('div');
            wrapper.className = 'page';
            var canvas = document.createElement('canvas');
            canvas.style.width = (viewport.width / scale) + 'px';
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            wrapper.appendChild(canvas);
            document.getElementById('viewer').appendChild(wrapper);
            page.render({
              canvasContext: canvas.getContext('2d'),
              viewport: viewport
            });
          });
        })(i);
      }
    }).catch(function(err) {
      document.getElementById('viewer').innerHTML = '<div class="error">' + safeErrorPrefix + ' ' + err.message + '</div>';
    });
  </script>
</body>
</html>`;
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#fff" },
    viewerContainer: { flex: 1, position: "relative", backgroundColor: "#f5f5f5" },
    loadingOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: "rgba(0,0,0,0.3)",
        justifyContent: "center",
        alignItems: "center",
    },
    modal: {
        backgroundColor: "#fff",
        marginHorizontal: 24,
        borderRadius: 16,
        padding: 24,
    },
    confirmBtn: {
        backgroundColor: "#ff5100",
        borderRadius: 10,
        paddingVertical: 16,
        alignItems: "center",
    },
    confirmBtnDisabled: { backgroundColor: "#f0c4a8" },
    confirmBtnIssue: { backgroundColor: "#c62828" },
    confirmBtnText: { color: "#fff", fontWeight: "bold", fontSize: 16 },
    statusToggleRow: { flexDirection: "row", gap: 10, marginBottom: 16 },
    statusToggleBtn: {
        flex: 1,
        borderWidth: 1,
        borderColor: "#ddd",
        borderRadius: 8,
        paddingVertical: 12,
        alignItems: "center",
    },
    statusToggleBtnOkActive: { backgroundColor: "#2e7d32", borderColor: "#2e7d32" },
    statusToggleBtnIssueActive: { backgroundColor: "#c62828", borderColor: "#c62828" },
    statusToggleText: { fontWeight: "600", color: "#333" },
    statusToggleTextActive: { color: "#fff" },
    cycleRow: { flexDirection: "row", gap: 8 },
    cyclePill: {
        width: 40,
        height: 40,
        borderRadius: 20,
        borderWidth: 1.5,
        borderColor: "#ddd",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#fff",
    },
    cyclePillChecked: { backgroundColor: "#2e7d32", borderColor: "#2e7d32" },
    cyclePillIssue: { backgroundColor: "#c62828", borderColor: "#c62828" },
    cyclePillSelected: { borderColor: "#ff5100", borderWidth: 3 },
    cyclePillText: { fontWeight: "700", color: "#333" },
    cyclePillTextLight: { color: "#fff" },
});

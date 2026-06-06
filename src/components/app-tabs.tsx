import { createMaterialTopTabNavigator } from '@react-navigation/material-top-tabs';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { getDatabase, onValue, ref } from 'firebase/database';
import React, { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Dimensions,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from 'react-native';
import { LineChart } from 'react-native-chart-kit';

// ─── Types ─────────────────────────────────────────────────────────────────

interface GpuInfo {
    name: string;
    type: 'integrated' | 'dedicated';
    load: number | null;
    temp: number | null;
    memoryTotal: number | null;
    memoryUsed: number | null;
    memoryFree?: number | null;
    driver?: string;
    uuid?: string;
}

interface ProcessInfo {
    name: string;
    cpu: number;
    ram: string;
}

interface LiveData {
    sensors: {
        os_name: string;
        kernel: string;
        plasma: string;
        ip: string;
        mac: string;
        model: string;
        hostname: string;
    };
    performance: {
        cpu_total: number;
        cpu_usages: number[];
        cpu_temps: number[];
        cpu_count: number;
    };
    gpus: GpuInfo[];
    memory: {
        ram_total: number;
        ram_used: number;
        ram_perc: number;
        ram_available: number;
        swap_total: number;
        swap_used: number;
        swap_perc: number;
    };
    traffic: {
        down: number;
        up: number;
    };
    power: {
        percent: number;
        charging: boolean;
        remaining_seconds: number;
    };
    procs: ProcessInfo[];
    sync_time: string;
    uptime_seconds: number;
}

interface HistoryState {
    cpu: number[];
    netDown: number[];
    netUp: number[];
    ram: number[];
    swap: number[];
}

// ─── Constants ─────────────────────────────────────────────────────────

const THEME = {
    bg: '#111214',
    card: '#1D2024',
    accent: '#3DAEE9',
    text: '#FFFFFF',
    muted: '#7F8C8D',
    danger: '#ED1515',
    success: '#2ECC71',
    warning: '#F39C12',
    nvidia: '#C724B1',
    orange: '#FDB338',
    upload: '#E74C3C',
    download: '#3DAEE9',
    border: '#2A2E33',
} as const;

const screenWidth = Dimensions.get('window').width;

const firebaseConfig = {
    databaseURL:
        'https://sys-monitor-c1c77-default-rtdb.asia-southeast1.firebasedatabase.app',
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getDatabase(app);

const Tab = createMaterialTopTabNavigator();

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatSpeed(kib: number | null | undefined): string {
    if (kib === null || kib === undefined) return '0 B/s';
    if (kib < 1) return `${Math.round(kib * 1024)} B/s`;
    if (kib < 1024) return `${kib.toFixed(1)} KiB/s`;
    return `${(kib / 1024).toFixed(2)} MiB/s`;
}

function chartSettings(color: string) {
    return {
        backgroundGradientFrom: THEME.card,
        backgroundGradientTo: THEME.card,
        color: () => color,
        strokeWidth: 2.5,
        propsForDots: { r: '0' },
        propsForBackgroundLines: { stroke: '#2A2E33' },
        decimalPlaces: 0,
        labelColor: () => THEME.muted,
    };
}

// ─── SpeedTicker ───────────────────────────────────────────────────────────

interface SpeedTickerProps {
    value: number | null | undefined;
    color: string;
    label: string;
    icon: string;
}

function SpeedTicker({ value, color, label, icon }: SpeedTickerProps) {
    const [displayVal, setDisplayVal] = useState<string>('0 B/s');

    useEffect(() => {
        setDisplayVal(formatSpeed(value));
    }, [value]);

    return (
        <View style={[styles.speedCard, { borderLeftColor: color }]}>
            <Text style={[styles.speedIcon, { color }]}>{icon}</Text>
            <View style={styles.speedInfo}>
                <Text style={[styles.speedLabel, { color: THEME.muted }]}>{label}</Text>
                <Text style={[styles.speedValue, { color }]}>
                    {displayVal}
                </Text>
            </View>
        </View>
    );
}

// ─── GpuBlock ──────────────────────────────────────────────────────────────

interface GpuBlockProps {
    gpu: GpuInfo;
    color: string;
}

function GpuBlock({ gpu, color }: GpuBlockProps) {
    const isIntegrated = gpu.type === 'integrated';
    const loadUnsupported = gpu.load === null || gpu.load === undefined;
    const tempUnsupported = gpu.temp === null || gpu.temp === undefined;
    const fullyUnsupported = loadUnsupported && tempUnsupported;
    const prefix = isIntegrated ? '⬡ INTEGRATED' : '◈ DEDICATED';

    if (fullyUnsupported) {
        return (
            <Box label={`${prefix}: ${gpu.name}`} color={THEME.muted}>
                <View style={styles.unsupportedBadge}>
                    <Text style={styles.unsupportedText}>⚠ System does not support this metric</Text>
                </View>
            </Box>
        );
    }

    const loadColor = !loadUnsupported
        ? (gpu.load as number) > 80
            ? THEME.danger
            : (gpu.load as number) > 50
                ? THEME.warning
                : color
        : THEME.muted;

    const tempColor = !tempUnsupported
        ? (gpu.temp as number) > 85
            ? THEME.danger
            : (gpu.temp as number) > 70
                ? THEME.warning
                : THEME.success
        : THEME.muted;

    const vramAvailable =
        gpu.memoryTotal != null &&
        gpu.memoryTotal > 0 &&
        gpu.memoryUsed != null &&
        gpu.memoryUsed >= 0;

    return (
        <Box label={`${prefix}: ${gpu.name}`} color={color}>
            <View style={styles.gpuMetricsRow}>
                <View style={styles.gpuMetricBlock}>
                    <Text style={styles.gpuMetricLabel}>LOAD</Text>
                    {loadUnsupported ? (
                        <Text style={[styles.gpuMetricVal, { color: THEME.muted, fontSize: 11 }]}>N/A</Text>
                    ) : (
                        <>
                            <Text style={[styles.gpuMetricVal, { color: loadColor }]}>
                                {(gpu.load as number).toFixed(1)}%
                            </Text>
                            <View style={styles.gpuTrack}>
                                <View
                                    style={[
                                        styles.gpuFill,
                                        {
                                            width: `${Math.min(gpu.load as number, 100)}%`,
                                            backgroundColor: loadColor,
                                        },
                                    ]}
                                />
                            </View>
                        </>
                    )}
                </View>

                <View style={styles.gpuSep} />

                <View style={styles.gpuMetricBlock}>
                    <Text style={styles.gpuMetricLabel}>TEMP</Text>
                    {tempUnsupported ? (
                        <Text style={[styles.gpuMetricVal, { color: THEME.muted, fontSize: 11 }]}>N/A</Text>
                    ) : (
                        <>
                            <Text style={[styles.gpuMetricVal, { color: tempColor }]}>
                                {(gpu.temp as number).toFixed(0)}°C
                            </Text>
                            <View style={styles.gpuTrack}>
                                <View
                                    style={[
                                        styles.gpuFill,
                                        {
                                            width: `${Math.min(((gpu.temp as number) / 110) * 100, 100)}%`,
                                            backgroundColor: tempColor,
                                        },
                                    ]}
                                />
                            </View>
                        </>
                    )}
                </View>
            </View>

            {vramAvailable && (
                <View style={{ marginTop: 12 }}>
                    <View style={styles.split}>
                        <Text style={styles.gpuMetricLabel}>VRAM</Text>
                        <Text style={[styles.gpuMetricLabel, { color: THEME.text }]}>
                            {gpu.memoryUsed} / {gpu.memoryTotal} MB
                            {` (${Math.round(((gpu.memoryUsed as number) / (gpu.memoryTotal as number)) * 100)}%)`}
                        </Text>
                    </View>
                    <View style={styles.gpuTrack}>
                        <View
                            style={[
                                styles.gpuFill,
                                {
                                    width: `${Math.min(
                                        ((gpu.memoryUsed as number) / (gpu.memoryTotal as number)) * 100,
                                        100
                                    )}%`,
                                    backgroundColor: color,
                                },
                            ]}
                        />
                    </View>
                </View>
            )}
        </Box>
    );
}

// ─── Box ───────────────────────────────────────────────────────────────────

interface BoxProps {
    label: string;
    color: string;
    children: React.ReactNode;
    rightText?: string;
}

const Box = ({ label, color, children, rightText }: BoxProps) => (
    <View style={[styles.box, { borderLeftColor: color }]}>
        <View style={styles.split}>
            <Text style={styles.miniLabel}>{label.toUpperCase()}</Text>
            {rightText ? <Text style={[styles.miniLabel, { color }]}>{rightText}</Text> : null}
        </View>
        {children}
    </View>
);

// ─── DataRow ───────────────────────────────────────────────────────────────

interface DataRowProps {
    l: string;
    r: string;
}

const DataRow = ({ l, r }: DataRowProps) => (
    <View style={styles.dRow}>
        <Text style={styles.labelM}>{l}:</Text>
        <Text style={[styles.text, { flexShrink: 1, textAlign: 'right', marginLeft: 8 }]}>{r}</Text>
    </View>
);

// ─── ProcessListMemo ───────────────────────────────────────────────────────────────

const ProcessListMemo = React.memo(({ procs }: { procs: ProcessInfo[] }) => {
    if (procs.length === 0) {
        return (
            <Text
                style={[styles.pText, { textAlign: 'center', paddingVertical: 20, color: THEME.muted }]}
            >
                No processes detected
            </Text>
        );
    }

    return (
        <>
            {procs.map((p: ProcessInfo, i: number) => (
                <View key={`proc-${i}`} style={styles.procRow}>
                    <Text numberOfLines={1} style={[styles.pText, { flex: 1, fontSize: 13 }]}>
                        {p.name ?? 'Unknown'}
                    </Text>
                    <View style={{ flexDirection: 'row' }}>
                        <Text
                            style={[
                                styles.pText,
                                { color: THEME.accent, width: 50, textAlign: 'right', fontSize: 12 },
                            ]}
                        >
                            {p.cpu ?? 0}%
                        </Text>
                        <Text
                            style={[
                                styles.pText,
                                { color: THEME.muted, width: 70, textAlign: 'right', fontSize: 12 },
                            ]}
                        >
                            {p.ram ?? '0 MB'}
                        </Text>
                    </View>
                </View>
            ))}
        </>
    );
});

ProcessListMemo.displayName = 'ProcessListMemo';

// ─── Main ──────────────────────────────────────────────────────────────────

export default function AppTabs() {
    const [data, setData] = useState<LiveData | null>(null);
    const [history, setHistory] = useState<HistoryState>({
        cpu: [0],
        netDown: [0],
        netUp: [0],
        ram: [0],
        swap: [0],
    });
    const [selectedGpu, setSelectedGpu] = useState<GpuInfo | null>(null);
    const [netMaxDown, setNetMaxDown] = useState<number>(100);
    const [netMaxUp, setNetMaxUp] = useState<number>(100);
    const updateCounterRef = useRef(0);

    const handleReset = () => {
        setHistory({ cpu: [0], netDown: [0], netUp: [0], ram: [0], swap: [0] });
        setNetMaxDown(100);
        setNetMaxUp(100);
    };

    useEffect(() => {
        const unsubscribe = onValue(ref(db, 'live_stats'), (snap) => {
            const val: LiveData | null = snap.val();
            if (!val) return;

            updateCounterRef.current += 1;
            setData(val);

            const down = val.traffic?.down ?? 0;
            const up = val.traffic?.up ?? 0;

            setNetMaxDown((prev) => Math.max(prev, down * 1.2, 1));
            setNetMaxUp((prev) => Math.max(prev, up * 1.2, 1));

            if (updateCounterRef.current % 5 === 0) {
                setHistory((prev) => ({
                    cpu: [...prev.cpu.slice(-29), Math.min(val.performance?.cpu_total ?? 0, 100)],
                    ram: [...prev.ram.slice(-29), Math.min(val.memory?.ram_perc ?? 0, 100)],
                    swap: [...prev.swap.slice(-29), Math.min(val.memory?.swap_perc ?? 0, 100)],
                    netDown: [
                        ...prev.netDown.slice(-29),
                        netMaxDown > 0 ? Math.min((down / netMaxDown) * 100, 100) : 0,
                    ],
                    netUp: [
                        ...prev.netUp.slice(-29),
                        netMaxUp > 0 ? Math.min((up / netMaxUp) * 100, 100) : 0,
                    ],
                }));
            }
        });
        return () => unsubscribe();
    }, [netMaxDown, netMaxUp]);

    if (!data) {
        return (
            <SafeAreaView style={styles.center}>
                <ActivityIndicator color={THEME.accent} size="large" />
                <Text style={styles.wait}>Syncing Hardware Link...</Text>
            </SafeAreaView>
        );
    }

    const HomeScreen = () => {
        const [homeData, setHomeData] = useState({
            osName: data.sensors?.os_name ?? 'System',
            plasma: data.sensors?.plasma ?? 'N/A',
            kernel: data.sensors?.kernel ?? 'N/A',
            ip: data.sensors?.ip ?? 'N/A',
            syncTime: data.sync_time ?? 'N/A',
            model: data.sensors?.model ?? 'N/A',
            ramUsed: String(data.memory?.ram_used ?? 0),
            ramTotal: String(data.memory?.ram_total ?? 0),
            hostname: data.sensors?.hostname ?? 'N/A',
        });

        useEffect(() => {
            setHomeData({
                osName: data.sensors?.os_name ?? 'System',
                plasma: data.sensors?.plasma ?? 'N/A',
                kernel: data.sensors?.kernel ?? 'N/A',
                ip: data.sensors?.ip ?? 'N/A',
                syncTime: data.sync_time ?? 'N/A',
                model: data.sensors?.model ?? 'N/A',
                ramUsed: String(data.memory?.ram_used ?? 0),
                ramTotal: String(data.memory?.ram_total ?? 0),
                hostname: data.sensors?.hostname ?? 'N/A',
            });
        }, [data]);

        return (
            <ScrollView style={styles.tabBg} showsVerticalScrollIndicator={false}>
                <View style={styles.fedoraCircle}>
                    <Text style={styles.fText}>f</Text>
                </View>
                <View style={styles.heroBox}>
                    <Text style={styles.h1}>{homeData.osName}</Text>
                    <Text style={styles.hSub}>KDE Plasma Mobile Dashboard</Text>
                </View>
                <Box label="Software Details" color={THEME.accent}>
                    <DataRow l="Plasma Version" r={homeData.plasma} />
                    <DataRow l="Kernel Version" r={homeData.kernel} />
                    <DataRow l="Local IP" r={homeData.ip} />
                    <DataRow l="Last Sync" r={homeData.syncTime} />
                </Box>
                <Box label="Hardware ID" color={THEME.success}>
                    <DataRow l="Product Model" r={homeData.model} />
                    <DataRow l="Main Memory" r={`${homeData.ramUsed} / ${homeData.ramTotal} GiB`} />
                    <DataRow l="Hostname" r={homeData.hostname} />
                </Box>
                <TouchableOpacity onPress={handleReset} style={styles.resetBtn}>
                    <Text style={styles.btnText}>RESET GRAPHS</Text>
                </TouchableOpacity>
            </ScrollView>
        );
    };

    const PerformanceScreen = () => {
        const [perfData, setPerfData] = useState({
            cpuTotal: data.performance?.cpu_total ?? 0,
            cpuUsages: data.performance?.cpu_usages ?? [],
            cpuTemps: data.performance?.cpu_temps ?? [],
        });

        useEffect(() => {
            setPerfData({
                cpuTotal: data.performance?.cpu_total ?? 0,
                cpuUsages: data.performance?.cpu_usages ?? [],
                cpuTemps: data.performance?.cpu_temps ?? [],
            });
        }, [data]);

        return (
            <ScrollView style={styles.tabBg} showsVerticalScrollIndicator={false}>
                <Box
                    label="CPU History"
                    color={THEME.accent}
                    rightText={`${perfData.cpuTotal}%`}
                >
                    <LineChart
                        data={{ datasets: [{ data: history.cpu.length > 0 ? history.cpu : [0] }] }}
                        width={screenWidth - 60}
                        height={140}
                        chartConfig={{ ...chartSettings(THEME.accent), yAxisSuffix: '%' }}
                        bezier={false}
                        withDots={false}
                        withInnerLines={true}
                        segments={5}
                        fromZero={true}
                    />
                </Box>
                <Text style={styles.groupHead}>DYNAMIC THERMAL CLUSTER</Text>
                <View style={styles.grid}>
                    {perfData.cpuUsages.map((usage: number, i: number) => (
                        <View key={`core-${i}`} style={styles.gridCard}>
                            <Text style={styles.coreNum}>CORE {i + 1}</Text>
                            <Text style={styles.coreVal}>
                                {perfData.cpuTemps?.[i] !== undefined
                                    ? `${perfData.cpuTemps[i].toFixed(0)}°C`
                                    : 'N/A'}
                            </Text>
                            <Text style={[styles.coreNum, { color: THEME.accent, marginBottom: 4 }]}>
                                {(usage ?? 0).toFixed(0)}%
                            </Text>
                            <View style={styles.track}>
                                <View
                                    style={[
                                        styles.fill,
                                        { width: `${Math.min(usage ?? 0, 100)}%`, backgroundColor: THEME.accent },
                                    ]}
                                />
                            </View>
                        </View>
                    ))}
                </View>
            </ScrollView>
        );
    };

    const GraphicsScreen = () => {
        if (selectedGpu) {
            return (
                <ScrollView style={styles.tabBg} showsVerticalScrollIndicator={false}>
                    <TouchableOpacity onPress={() => setSelectedGpu(null)} style={styles.resetBtn}>
                        <Text style={styles.btnText}>← BACK TO ALL GPUS</Text>
                    </TouchableOpacity>
                    <Box label={`TECHNICAL: ${selectedGpu.name}`} color={THEME.nvidia}>
                        <DataRow l="Driver Version" r={selectedGpu.driver ?? 'N/A'} />
                        <DataRow l="UUID" r={selectedGpu.uuid ?? 'N/A'} />
                        <DataRow l="VRAM Total" r={`${selectedGpu.memoryTotal ?? 0} MB`} />
                        <DataRow l="VRAM Used" r={`${selectedGpu.memoryUsed ?? 0} MB`} />
                        <DataRow l="VRAM Free" r={`${selectedGpu.memoryFree ?? 0} MB`} />
                        <DataRow l="GPU Load" r={`${(selectedGpu.load ?? 0).toFixed(1)}%`} />
                        <DataRow l="Temperature" r={`${(selectedGpu.temp ?? 0).toFixed(0)}°C`} />
                    </Box>
                </ScrollView>
            );
        }

        const gpus: GpuInfo[] = data!.gpus ?? [];
        const integrated = gpus.filter((g) => g.type === 'integrated');
        const dedicated = gpus.filter((g) => g.type === 'dedicated');

        return (
            <ScrollView style={styles.tabBg} showsVerticalScrollIndicator={false}>
                {integrated.length > 0 && (
                    <>
                        <Text style={styles.groupHead}>INTEGRATED GRAPHICS</Text>
                        {integrated.map((gpu, i) => (
                            <View key={`igpu-${i}`}>
                                <GpuBlock key={`igpu-block-${i}`} gpu={gpu} color={THEME.success} />
                                <Box label={`${gpu.name} - Memory Details`} color={THEME.success}>
                                    <DataRow l="VRAM Total" r={`${gpu.memoryTotal ?? 'N/A'} MB`} />
                                    <DataRow l="VRAM Used" r={`${gpu.memoryUsed ?? 'N/A'} MB`} />
                                    {gpu.memoryFree !== undefined && (
                                        <DataRow l="VRAM Free" r={`${gpu.memoryFree ?? 'N/A'} MB`} />
                                    )}
                                </Box>
                            </View>
                        ))}
                    </>
                )}

                {dedicated.length > 0 && (
                    <>
                        <Text style={styles.groupHead}>DEDICATED GRAPHICS</Text>
                        {dedicated.map((gpu, i) => (
                            <View key={`dgpu-${i}`}>
                                <GpuBlock gpu={gpu} color={THEME.nvidia} />
                                <Box label={`${gpu.name} - Memory Details`} color={THEME.nvidia}>
                                    <DataRow l="VRAM Total" r={`${gpu.memoryTotal ?? 'N/A'} MB`} />
                                    <DataRow l="VRAM Used" r={`${gpu.memoryUsed ?? 'N/A'} MB`} />
                                    {gpu.memoryFree !== undefined && (
                                        <DataRow l="VRAM Free" r={`${gpu.memoryFree ?? 'N/A'} MB`} />
                                    )}
                                    {gpu.driver && <DataRow l="Driver" r={gpu.driver} />}
                                </Box>
                                <TouchableOpacity
                                    onPress={() => setSelectedGpu(gpu)}
                                    style={[styles.resetBtn, { marginTop: 0, marginBottom: 15 }]}
                                >
                                    <Text style={styles.btnText}>VIEW FULL DETAILS</Text>
                                </TouchableOpacity>
                            </View>
                        ))}
                    </>
                )}

                {dedicated.length === 0 && (
                    <Box label="DEDICATED GPU" color={THEME.muted}>
                        <View style={styles.unsupportedBadge}>
                            <Text style={styles.unsupportedText}>
                                ⚠ No dedicated GPU detected on this system
                            </Text>
                        </View>
                    </Box>
                )}

                <Box label="Memory Metrics" color={THEME.accent}>
                    <View style={styles.split}>
                        <Text style={styles.miniLabel}>RAM USAGE</Text>
                        <Text style={[styles.miniLabel, { color: THEME.accent }]}>
                            {data!.memory?.ram_used} / {data!.memory?.ram_total} GiB
                            {'  '}({data!.memory?.ram_perc}%)
                        </Text>
                    </View>
                    <LineChart
                        data={{ datasets: [{ data: history.ram.length > 0 ? history.ram : [0] }] }}
                        width={screenWidth - 60}
                        height={110}
                        chartConfig={{ ...chartSettings(THEME.accent), yAxisSuffix: '%' }}
                        bezier={false}
                        withDots={false}
                        fromZero={true}
                        segments={5}
                    />
                    <View style={[styles.split, { marginTop: 15 }]}>
                        <Text style={styles.miniLabel}>SWAP USAGE</Text>
                        <Text style={[styles.miniLabel, { color: THEME.muted }]}>
                            {data!.memory?.swap_used} / {data!.memory?.swap_total} GiB
                            {'  '}({data!.memory?.swap_perc}%)
                        </Text>
                    </View>
                    <LineChart
                        data={{ datasets: [{ data: history.swap.length > 0 ? history.swap : [0] }] }}
                        width={screenWidth - 60}
                        height={110}
                        chartConfig={{ ...chartSettings(THEME.muted), yAxisSuffix: '%' }}
                        bezier={false}
                        withDots={false}
                        fromZero={true}
                        segments={5}
                    />
                </Box>
            </ScrollView>
        );
    };

    const ActivityScreen = () => {
        const [activityData, setActivityData] = useState({
            downSpeed: data.traffic?.down ?? 0,
            upSpeed: data.traffic?.up ?? 0,
            downFormatted: formatSpeed(data.traffic?.down),
            upFormatted: formatSpeed(data.traffic?.up),
            procs: data.procs ?? [],
            localIp: data.sensors?.ip ?? 'N/A',
            macAddr: data.sensors?.mac ?? 'N/A',
        });

        useEffect(() => {
            setActivityData({
                downSpeed: data.traffic?.down ?? 0,
                upSpeed: data.traffic?.up ?? 0,
                downFormatted: formatSpeed(data.traffic?.down),
                upFormatted: formatSpeed(data.traffic?.up),
                procs: data.procs ?? [],
                localIp: data.sensors?.ip ?? 'N/A',
                macAddr: data.sensors?.mac ?? 'N/A',
            });
        }, [data]);

        return (
            <ScrollView style={styles.tabBg} showsVerticalScrollIndicator={false} scrollEventThrottle={16}>
                <Text style={styles.groupHead}>LIVE BANDWIDTH</Text>
                <SpeedTicker value={activityData.downSpeed} color={THEME.download} label="DOWNLOAD" icon="↓" />
                <SpeedTicker value={activityData.upSpeed} color={THEME.upload} label="UPLOAD" icon="↑" />

                <Box
                    label="Download History"
                    color={THEME.download}
                    rightText={`↓ ${activityData.downFormatted}`}
                >
                    <LineChart
                        data={{ datasets: [{ data: history.netDown.length > 0 ? history.netDown : [0] }] }}
                        width={screenWidth - 60}
                        height={110}
                        chartConfig={{ ...chartSettings(THEME.download), yAxisSuffix: '%' }}
                        withDots={false}
                        bezier={false}
                        fromZero={true}
                        segments={4}
                    />
                    <Text style={styles.networkNote}>
                        Normalized to peak — actual: {activityData.downFormatted}
                    </Text>
                </Box>

                <Box
                    label="Upload History"
                    color={THEME.upload}
                    rightText={`↑ ${activityData.upFormatted}`}
                >
                    <LineChart
                        data={{ datasets: [{ data: history.netUp.length > 0 ? history.netUp : [0] }] }}
                        width={screenWidth - 60}
                        height={110}
                        chartConfig={{ ...chartSettings(THEME.upload), yAxisSuffix: '%' }}
                        withDots={false}
                        bezier={false}
                        fromZero={true}
                        segments={4}
                    />
                    <Text style={styles.networkNote}>
                        Normalized to peak — actual: {activityData.upFormatted}
                    </Text>
                </Box>

                <Box label="Device Identity" color={THEME.accent}>
                    <View style={styles.identitySection}>
                        <View style={styles.identityRow}>
                            <Text style={styles.identityLabel}>Local IP</Text>
                            <Text style={styles.identityValue}>{activityData.localIp}</Text>
                        </View>
                        <View
                            style={[
                                styles.identityRow,
                                { borderTopWidth: 1, borderTopColor: THEME.border, paddingTop: 12, marginTop: 12 },
                            ]}
                        >
                            <Text style={styles.identityLabel}>MAC Address</Text>
                            <Text style={styles.identityValue}>{activityData.macAddr}</Text>
                        </View>
                    </View>
                </Box>

                <View style={styles.split}>
                    <Text style={styles.groupHead}>ACTIVE PROCESSES</Text>
                    <Text style={[styles.groupHead, { color: THEME.accent }]}>CPU | RAM</Text>
                </View>

                <ProcessListMemo procs={activityData.procs} />
            </ScrollView>
        );
    };

    return (
        <Tab.Navigator
            screenOptions={{
                tabBarStyle: { backgroundColor: THEME.bg, borderTopWidth: 1, borderTopColor: THEME.border },
                tabBarLabelStyle: { fontSize: 10, fontWeight: 'bold' },
                tabBarActiveTintColor: THEME.accent,
                tabBarInactiveTintColor: THEME.muted,
                tabBarIndicatorStyle: { backgroundColor: THEME.accent, height: 3 },
            }}
        >
            <Tab.Screen name="HOME" component={HomeScreen} />
            <Tab.Screen name="CPU" component={PerformanceScreen} />
            <Tab.Screen name="GRAPHICS" component={GraphicsScreen} />
            <Tab.Screen name="ACTIVITY" component={ActivityScreen} />
        </Tab.Navigator>
    );
}

const styles = StyleSheet.create({
    tabBg: { flex: 1, backgroundColor: THEME.bg, padding: 15 },
    center: { flex: 1, backgroundColor: THEME.bg, justifyContent: 'center', alignItems: 'center' },
    wait: { color: '#fff', marginTop: 15, fontSize: 12, fontWeight: 'bold' },
    fedoraCircle: {
        alignSelf: 'center',
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: THEME.accent,
        justifyContent: 'center',
        alignItems: 'center',
        marginVertical: 30,
    },
    fText: { color: '#fff', fontSize: 50, fontWeight: '900' },
    heroBox: { alignItems: 'center', marginBottom: 30 },
    h1: { color: '#fff', fontSize: 28, fontWeight: 'bold' },
    hSub: { color: THEME.accent, fontWeight: '600', fontSize: 14 },
    box: { backgroundColor: THEME.card, padding: 15, borderRadius: 10, marginBottom: 15, borderLeftWidth: 3 },
    split: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    miniLabel: { color: THEME.muted, fontSize: 10, fontWeight: 'bold', marginBottom: 10 },
    dRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 },
    labelM: { color: THEME.muted, fontSize: 11 },
    text: { color: THEME.text, fontWeight: '700', fontSize: 13 },
    resetBtn: {
        alignSelf: 'center',
        backgroundColor: '#2C3034',
        paddingVertical: 12,
        paddingHorizontal: 25,
        borderRadius: 8,
        marginTop: 15,
        marginBottom: 5,
        borderWidth: 1,
        borderColor: '#3A3F45',
    },
    btnText: { color: THEME.accent, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
    groupHead: { color: THEME.muted, fontSize: 10, fontWeight: 'bold', marginVertical: 12, letterSpacing: 1.5 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
    gridCard: {
        width: '31%',
        backgroundColor: THEME.card,
        padding: 10,
        borderRadius: 10,
        marginBottom: 10,
        alignItems: 'center',
    },
    coreNum: { color: THEME.muted, fontSize: 10 },
    coreVal: { color: '#fff', fontSize: 16, fontWeight: '800', marginVertical: 3 },
    track: { width: '100%', height: 3, backgroundColor: '#333', borderRadius: 1.5 },
    fill: { height: '100%', borderRadius: 1.5 },
    procRow: { flexDirection: 'row', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#232529' },
    pText: { color: '#fff', fontSize: 14 },
    identitySection: { paddingVertical: 5 },
    identityRow: { paddingVertical: 8 },
    identityLabel: { color: THEME.muted, fontSize: 11, fontWeight: '600', marginBottom: 4 },
    identityValue: { color: THEME.accent, fontSize: 14, fontWeight: '700', fontFamily: 'monospace' },
    networkNote: { color: THEME.muted, fontSize: 9, marginTop: 6, fontStyle: 'italic' },
    speedCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: THEME.card,
        borderRadius: 10,
        borderLeftWidth: 3,
        padding: 14,
        marginBottom: 10,
    },
    speedIcon: { fontSize: 26, fontWeight: '900', marginRight: 14, width: 28, textAlign: 'center' },
    speedInfo: { flex: 1 },
    speedLabel: { fontSize: 9, fontWeight: 'bold', letterSpacing: 1.5, marginBottom: 3 },
    speedValue: { fontSize: 22, fontWeight: '900', fontFamily: 'monospace' },
    gpuMetricsRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 6 },
    gpuMetricBlock: { flex: 1, alignItems: 'center' },
    gpuMetricLabel: { color: THEME.muted, fontSize: 9, fontWeight: 'bold', letterSpacing: 1, marginBottom: 4 },
    gpuMetricVal: { fontSize: 20, fontWeight: '900', marginBottom: 4 },
    gpuSep: { width: 1, height: 40, backgroundColor: THEME.border, marginHorizontal: 10 },
    gpuTrack: { width: '100%', height: 4, backgroundColor: '#2A2E33', borderRadius: 2, marginTop: 4 },
    gpuFill: { height: '100%', borderRadius: 2 },
    unsupportedBadge: {
        backgroundColor: '#1A1D20',
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#3A3F45',
        padding: 14,
        alignItems: 'center',
    },
    unsupportedText: { color: THEME.muted, fontSize: 12, fontStyle: 'italic', textAlign: 'center' },
});
import os
import psutil
import GPUtil
import time
import firebase_admin
import platform
import subprocess
import socket
from firebase_admin import credentials, db

# 1. AUTO-DETECT FILE PATHS
# This ensures it finds the json file regardless of where you start the terminal
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
JSON_PATH = os.path.join(
    BASE_DIR, " Projects/sysmonitor/sys-monitor.json "
)  # add secret key.jon from services link here in " " from firebase

# FIREBASE INITIALIZATION
if not os.path.exists(JSON_PATH):
    print(f"❌ ERROR: File '{JSON_PATH}' not found. Place it in this folder.")
    exit()

cred = credentials.Certificate(JSON_PATH)
firebase_admin.initialize_app(
    cred,
    {"databaseURL": "https://sys-monitor-c1c77-default-rtdb.asia-southeast1.firebasedatabase.app"},  # realtime database link from my firebase
)
ref = db.reference("/live_stats")


def get_running_procs():
    procs = []
    # Collect top 8 processes by CPU usage
    for proc in sorted(
        psutil.process_iter(["name", "cpu_percent", "memory_info"]),
        key=lambda p: p.info["cpu_percent"] or 0,
        reverse=True,
    )[:8]:
        try:
            procs.append(
                {
                    "name": proc.info["name"],
                    "cpu": round(proc.info["cpu_percent"] or 0, 1),
                    "ram": f"{round(proc.info['memory_info'].rss / (1024**2), 1)} MB",
                }
            )
        except:
            continue
    return procs


def get_sys_model():
    """Fetches the system product name/model."""
    try:
        if platform.system() == "Linux":
            # Typical path for Linux systems (Fedora/Debian/etc)
            with open("/sys/class/dmi/id/product_name", "r") as f:
                return f.read().strip()
        elif platform.system() == "Windows":
            return platform.node()  # Fallback for Windows
    except:
        return "Unknown Model"


def get_cpu_data():
    # Fetch all thermal sensors
    temps = psutil.sensors_temperatures()
    all_temps = []

    # Common sensor keys in Linux for Intel/AMD CPUs
    # You might need to adjust 'coretemp' to 'k10temp' or similar based on your CPU
    if "coretemp" in temps:
        # Filter for sensors that have 'Core' in their label
        all_temps = [s.current for s in temps["coretemp"] if "Core" in s.label]

    # Fallback: if sensors are fewer than cores, repeat/pad the last known temp
    # to avoid index errors in your React Native app
    cpu_count = psutil.cpu_count(logical=True)
    while len(all_temps) < cpu_count:
        all_temps.append(all_temps[-1] if all_temps else 40.0)

    return all_temps[:cpu_count]


def get_cpu_telemetry():
    usages = psutil.cpu_percent(percpu=True)
    temps = psutil.sensors_temperatures()

    # 1. Capture the correct 'Package id' temperature
    # This is the most accurate reading for the entire CPU die
    package_temp = 40.0  # Default fallback
    for adapter in temps:
        for sensor in temps[adapter]:
            if "Package" in sensor.label or "Tdie" in sensor.label:
                package_temp = sensor.current
                break

    # 2. Map this single, accurate reading to all cores
    # This eliminates "off" readings caused by multi-sensor noise
    logical_cores = psutil.cpu_count(logical=True)
    temps_data = [package_temp] * logical_cores

    return usages, temps_data


def get_gpu_data():
    gpus_data = []
    try:
        for g in GPUtil.getGPUs():
            gpus_data.append(
                {
                    "name": g.name,
                    "driver": g.driver,
                    "uuid": g.uuid,
                    "load": g.load * 100,
                    "temp": g.temperature,
                    "memoryTotal": g.memoryTotal,
                    "memoryUsed": g.memoryUsed,
                    "memoryFree": g.memoryFree,
                }
            )
    except:
        pass
    return gpus_data


def fetch_live_data():
    # Capture telemetry
    usages, temps = get_cpu_telemetry()

    mem = psutil.virtual_memory()
    swp = psutil.swap_memory()

    net_prev = psutil.net_io_counters()
    time.sleep(1)
    net_now = psutil.net_io_counters()

    battery = psutil.sensors_battery()

    return {
        "sensors": {
            "os_name": f"{platform.system()} {platform.release()}",
            "kernel": platform.version(),
            "plasma": "6.6 (Adaptive)",
            "ip": socket.gethostbyname(socket.gethostname()),
            "model": get_sys_model(),  # Ensure this is defined elsewhere in your script
        },
        "performance": {
            "cpu_total": psutil.cpu_percent(),
            "cpu_usages": usages,  # Now explicitly aligned
            "cpu_temps": temps,  # Now explicitly aligned
        },
        "gpus": get_gpu_data(),
        "memory": {
            "ram_total": round(mem.total / (1024**3), 1),
            "ram_used": round(mem.used / (1024**3), 1),
            "ram_perc": mem.percent,
            "swap_perc": swp.percent,
            "swap_used": round(swp.used / (1024**3), 1),
        },
        "traffic": {
            "down": round((net_now.bytes_recv - net_prev.bytes_recv) / 1024, 1),
            "up": round((net_now.bytes_sent - net_prev.bytes_sent) / 1024, 1),
        },
        "power": {
            "battery": battery.percent if battery else 100,
            "charging": battery.power_plugged if battery else True,
        },
        "procs": get_running_procs(),
        "sync_time": time.strftime("%H:%M:%S"),
    }


# START SERVICE
print(f"🌍 Starting Universal Sync from: {platform.node()}")
print(f"Detection OS: {platform.system()}")

while True:
    try:
        # Pushes whole system state once per second
        current_data = fetch_live_data()
        ref.set(current_data)
        # Verify sync in console
        print(
            f"[{current_data['sync_time']}] System: {current_data['performance']['cpu_total']}% | Sync Status: ✅"
        )
    except KeyboardInterrupt:
        break
    except Exception as e:
        print(f"Sync Failure: {e}")

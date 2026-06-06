import os
import json
import psutil
import GPUtil
import time
import firebase_admin
import platform
import subprocess
import socket
import uuid
from firebase_admin import credentials, db

# ============================================================================
# CONFIGURATION & INITIALIZATION
# ============================================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
JSON_PATH = os.path.join(BASE_DIR, "sys-monitor.json")

if not os.path.exists(JSON_PATH):
    print(f"❌ ERROR: File '{JSON_PATH}' not found.")
    exit(1)

try:
    cred = credentials.Certificate(JSON_PATH)
    firebase_admin.initialize_app(
        cred,
        {
            "databaseURL": "https://sys-monitor-c1c77-default-rtdb.asia-southeast1.firebasedatabase.app"
        },
    )
    ref = db.reference("/live_stats")
    print("✅ Firebase connected successfully")
except Exception as e:
    print(f"❌ Firebase connection failed: {e}")
    exit(1)

last_net_io = psutil.net_io_counters()
last_time = time.time()

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def get_system_model():
    try:
        if platform.system() == "Linux":
            paths = [
                "/sys/class/dmi/id/product_name",
                "/sys/class/dmi/id/board_name",
                "/sys/class/dmi/id/system_product_name",
            ]
            for path in paths:
                try:
                    with open(path, "r") as f:
                        model = f.read().strip()
                        if model and model != "System Product Name":
                            return model
                except:
                    continue
            return platform.node()
        elif platform.system() == "Windows":
            return platform.node()
        elif platform.system() == "Darwin":
            return subprocess.check_output(["sysctl", "-n", "hw.model"]).decode().strip()
    except:
        return "Unknown Model"


def get_plasma_version():
    try:
        version = os.environ.get("KDE_SESSION_VERSION")
        if version:
            return f"{version}.x"
        result = subprocess.check_output(
            ["plasmashell", "--version"], stderr=subprocess.DEVNULL, timeout=2
        ).decode().strip()
        return result.split()[-1]
    except:
        return "Unknown"


def get_mac_address():
    try:
        mac = uuid.getnode()
        return ":".join(("%012X" % mac)[i : i + 2] for i in range(0, 12, 2))
    except:
        return "00:00:00:00:00:00"


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"


def get_cpu_telemetry():
    """Get CPU usage and temperatures for all cores"""
    usages = psutil.cpu_percent(percpu=True, interval=0.1)
    temps_data = []
    
    try:
        temps = psutil.sensors_temperatures()
        sensor_keys = ["coretemp", "k10temp", "acpitz", "nct6798", "it8792e"]
        
        for key in sensor_keys:
            if key in temps:
                temps_data = [
                    s.current
                    for s in temps[key]
                    if "Core" in s.label or "CPU" in s.label or "Package" in s.label
                ]
                if temps_data:
                    break
        
        if not temps_data and temps:
            first_key = list(temps.keys())[0]
            temps_data = [s.current for s in temps[first_key]]
    except:
        temps_data = []

    logical_cores = psutil.cpu_count(logical=True)
    
    if len(temps_data) < logical_cores:
        filler = temps_data[-1] if temps_data else 40.0
        temps_data.extend([filler] * (logical_cores - len(temps_data)))
    elif len(temps_data) > logical_cores:
        temps_data = temps_data[:logical_cores]

    return usages, temps_data


def get_integrated_gpu_data():
    """
    Attempt to read integrated GPU (Intel/AMD iGPU) metrics.
    Returns a dict with available metrics (null fields if unsupported).
    """
    igpu = {
        "name": None,
        "load": None,
        "temp": None,
        "memoryTotal": None,
        "memoryUsed": None,
        "type": "integrated",
    }

    # --- Intel iGPU via intel_gpu_top (Linux) ---
    if platform.system() == "Linux":
        # Try reading Intel GPU load via intel_gpu_top
        try:
            result = subprocess.check_output(
                ["intel_gpu_top", "-J", "-s", "100", "-n", "1"],
                stderr=subprocess.DEVNULL,
                timeout=2,
            ).decode()
            parsed = json.loads(result)
            engines = parsed.get("engines", {})
            total_busy = sum(
                v.get("busy", 0)
                for k, v in engines.items()
                if isinstance(v, dict)
            )
            igpu["name"] = "Intel Integrated GPU"
            igpu["load"] = round(min(total_busy, 100), 1)
        except:
            pass

        # Try reading iGPU temperature via hwmon/sysfs
        if igpu["temp"] is None:
            try:
                temps = psutil.sensors_temperatures()
                for key in ["i915", "amdgpu", "radeon", "amdgpu_soc"]:
                    if key in temps:
                        t_list = [s.current for s in temps[key]]
                        if t_list:
                            igpu["temp"] = round(t_list[0], 1)
                            if igpu["name"] is None:
                                igpu["name"] = "Integrated GPU"
                            break
            except:
                pass

        # Try AMD iGPU via sysfs
        if igpu["load"] is None:
            try:
                amd_path = "/sys/class/drm/card0/device/gpu_busy_percent"
                with open(amd_path) as f:
                    igpu["load"] = round(float(f.read().strip()), 1)
                    if igpu["name"] is None:
                        igpu["name"] = "AMD Integrated GPU"
            except:
                pass

        # Try AMD VRAM info
        try:
            vram_total_path = "/sys/class/drm/card0/device/mem_info_vram_total"
            vram_used_path = "/sys/class/drm/card0/device/mem_info_vram_used"
            with open(vram_total_path) as f:
                total_bytes = int(f.read().strip())
                igpu["memoryTotal"] = int(total_bytes / (1024 ** 2))
            with open(vram_used_path) as f:
                used_bytes = int(f.read().strip())
                igpu["memoryUsed"] = int(used_bytes / (1024 ** 2))
        except:
            pass

        # Try Intel VRAM via i915/i915_gem_objects
        if igpu["memoryTotal"] is None:
            try:
                with open("/sys/class/drm/card0/device/drm/card0/gt/gt0/mem_used_bytes") as f:
                    used = int(f.read().strip()) / (1024 ** 2)
                    igpu["memoryUsed"] = int(used)
            except:
                pass

    # Default name if nothing found
    if igpu["name"] is None:
        igpu["name"] = "Integrated GPU"

    return igpu


def get_gpu_data():
    """Returns a list of all GPUs: [integrated_gpu, ...dedicated_gpus...]"""
    all_gpus = []

    # 1. Integrated GPU
    igpu = get_integrated_gpu_data()
    all_gpus.append(igpu)

    # 2. Dedicated GPUs via GPUtil (NVIDIA/AMD)
    try:
        gpu_list = GPUtil.getGPUs()
        for g in gpu_list:
            all_gpus.append({
                "name": g.name,
                "type": "dedicated",
                "driver": str(g.driver) if g.driver else "Unknown",
                "uuid": str(g.uuid) if g.uuid else "N/A",
                "load": round(float(g.load) * 100, 1),
                "temp": round(float(g.temperature), 1),
                "memoryTotal": int(g.memoryTotal),
                "memoryUsed": int(g.memoryUsed),
                "memoryFree": int(g.memoryFree),
            })
    except Exception as e:
        pass

    return all_gpus


def get_running_procs(limit=10):
    """Get top processes by CPU usage"""
    procs = []
    try:
        for proc in sorted(
            psutil.process_iter(["pid", "name", "cpu_percent", "memory_info"]),
            key=lambda p: p.info["cpu_percent"] or 0,
            reverse=True,
        )[:limit]:
            try:
                cpu_pct = proc.info["cpu_percent"] or 0
                mem_mb = proc.info["memory_info"].rss / (1024 ** 2)
                procs.append({
                    "name": proc.info["name"],
                    "cpu": round(cpu_pct, 1),
                    "ram": f"{round(mem_mb, 1)} MB",
                })
            except:
                continue
    except:
        pass
    
    return procs


def calculate_network_speed():
    """Calculate network speed in KiB/s"""
    global last_net_io, last_time
    now = time.time()
    net_now = psutil.net_io_counters()
    dt = max(now - last_time, 0.1)
    
    down_kib_s = (net_now.bytes_recv - last_net_io.bytes_recv) / dt / 1024
    up_kib_s = (net_now.bytes_sent - last_net_io.bytes_sent) / dt / 1024
    
    last_net_io = net_now
    last_time = now
    
    return round(down_kib_s, 2), round(up_kib_s, 2)


def get_battery_info():
    """Get battery status and remaining time"""
    try:
        battery = psutil.sensors_battery()
        if battery:
            return {
                "percent": round(battery.percent, 1),
                "charging": bool(battery.power_plugged),
                "remaining_seconds": (
                    battery.secsleft
                    if battery.secsleft != psutil.POWER_TIME_UNLIMITED
                    else -1
                ),
            }
        return {"percent": 100, "charging": True, "remaining_seconds": -1}
    except:
        return {"percent": 100, "charging": True, "remaining_seconds": -1}


# ============================================================================
# MAIN DATA COLLECTION
# ============================================================================

def fetch_live_data():
    """Collect all system monitoring data"""
    try:
        cpu_usages, cpu_temps = get_cpu_telemetry()
        cpu_total = psutil.cpu_percent(interval=0.1)

        # Memory: use more accurate calculation
        mem = psutil.virtual_memory()
        # ram_used = total - available (accounts for cache/buffers)
        ram_used_accurate = mem.total - mem.available

        swp = psutil.swap_memory()
        down_kib_s, up_kib_s = calculate_network_speed()
        gpus_data = get_gpu_data()
        procs = get_running_procs(limit=10)
        battery_info = get_battery_info()

        return {
            "sensors": {
                "os_name": f"{platform.system()} {platform.release()}",
                "kernel": platform.version(),
                "plasma": get_plasma_version(),
                "ip": get_local_ip(),
                "mac": get_mac_address(),
                "model": get_system_model(),
                "hostname": socket.gethostname(),
            },
            "performance": {
                "cpu_total": round(cpu_total, 1),
                "cpu_usages": [round(u, 1) for u in cpu_usages],
                "cpu_temps": [round(t, 1) for t in cpu_temps],
                "cpu_count": psutil.cpu_count(logical=True),
            },
            "gpus": gpus_data,
            "memory": {
                "ram_total": round(mem.total / (1024 ** 3), 2),
                "ram_used": round(ram_used_accurate / (1024 ** 3), 2),
                "ram_perc": round((ram_used_accurate / mem.total) * 100, 1),
                "ram_available": round(mem.available / (1024 ** 3), 2),
                "swap_total": round(swp.total / (1024 ** 3), 2),
                "swap_used": round(swp.used / (1024 ** 3), 2),
                "swap_perc": round(swp.percent, 1),
            },
            "traffic": {
                "down": down_kib_s,
                "up": up_kib_s,
            },
            "power": battery_info,
            "procs": procs,
            "sync_time": time.strftime("%H:%M:%S"),
            "uptime_seconds": int(time.time() - psutil.boot_time()),
        }
    except Exception as e:
        print(f"❌ fetch_live_data error: {e}")
        return None


# ============================================================================
# MAIN SERVICE LOOP
# ============================================================================

def main():
    sync_count = 0
    error_count = 0
    
    try:
        print("🚀 System Monitor started...")
        while True:
            try:
                current_data = fetch_live_data()
                if current_data:
                    ref.set(current_data)
                    sync_count += 1
                    
                    # Print status every 50 syncs
                    if sync_count % 50 == 0:
                        print(f"✅ {sync_count} syncs | {current_data['sync_time']} | "
                              f"CPU: {current_data['performance']['cpu_total']}% | "
                              f"RAM: {current_data['memory']['ram_perc']}%")
                    
                    error_count = 0
                else:
                    error_count += 1
                    if error_count >= 10:
                        print(f"⚠️  Multiple data fetch failures detected")
                        error_count = 0
                
                time.sleep(0.1)
            except Exception as e:
                error_count += 1
                print(f"❌ Loop error: {e}")
                time.sleep(0.5)
    
    except KeyboardInterrupt:
        print(f"\n🛑 Stopped after {sync_count} syncs.")
    except Exception as e:
        print(f"❌ Fatal error: {e}")
        exit(1)


if __name__ == "__main__":
    main()
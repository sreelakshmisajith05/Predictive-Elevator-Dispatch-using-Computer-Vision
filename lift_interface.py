"""
SmartLift - Python Serial Interface (Optimized)
Communicates with ESP32 SmartLift controller over Serial (USB).

Features:
- Real-time updates ONLY when floor or sensor status changes (no terminal spam).
- Clean interactive CLI prompt.
- Top-sensor priority detection.
"""

import sys
import time
import re
import threading
import serial
import serial.tools.list_ports

BAUD_RATE = 115200


def determine_floor(sensors: dict) -> str:
    """
    Evaluates current floor based on sensor states with top-sensor priority.
    sensors dict: {"G": bool, "1": bool, "2": bool, "3": bool}
    True indicates sensor is triggered (digital LOW).
    """
    if sensors.get("3", False):
        return "3rd Floor"
    elif sensors.get("2", False):
        return "2nd Floor"
    elif sensors.get("1", False):
        return "1st Floor"
    elif sensors.get("G", False):
        return "Ground Floor (G)"
    else:
        return "Between Floors / In Transit"


def parse_sensor_line(line: str) -> dict | None:
    """
    Parses sensor values from lines like:
    'G: LOW | 1: HIGH | 2: HIGH | 3: HIGH' or 'G:LOW, 1:LOW, ...'
    """
    patterns = {
        "G": re.search(r"\bG\s*[:=]\s*(LOW|HIGH|0|1)\b", line, re.IGNORECASE),
        "1": re.search(r"\b1\s*[:=]\s*(LOW|HIGH|0|1)\b", line, re.IGNORECASE),
        "2": re.search(r"\b2\s*[:=]\s*(LOW|HIGH|0|1)\b", line, re.IGNORECASE),
        "3": re.search(r"\b3\s*[:=]\s*(LOW|HIGH|0|1)\b", line, re.IGNORECASE),
    }

    if not any(patterns.values()):
        return None

    def is_triggered(match):
        if not match:
            return False
        val = match.group(1).upper()
        return val in ("LOW", "0")

    return {
        "G": is_triggered(patterns["G"]),
        "1": is_triggered(patterns["1"]),
        "2": is_triggered(patterns["2"]),
        "3": is_triggered(patterns["3"]),
    }


def serial_reader_thread(ser: serial.Serial, stop_event: threading.Event, state: dict):
    """Continuously reads lines from the ESP32 serial port."""
    last_printed_floor = None
    last_printed_sensors = None

    while not stop_event.is_set():
        try:
            if ser.in_waiting > 0:
                raw_bytes = ser.readline()
                line = raw_bytes.decode("utf-8", errors="replace").strip()
                if not line:
                    continue

                sensors = parse_sensor_line(line)
                if sensors:
                    floor = determine_floor(sensors)
                    state["last_sensors"] = sensors
                    state["current_floor"] = floor

                    # ONLY print if floor or sensor readings actually changed!
                    if floor != last_printed_floor or sensors != last_printed_sensors:
                        last_printed_floor = floor
                        last_printed_sensors = sensors

                        raw_str = ", ".join(
                            f"{k}:{'TRIGGERED' if v else 'open'}"
                            for k, v in sensors.items()
                        )
                        print(f"\n[LIFT STATUS] Position: >> {floor} <<  ({raw_str})")
                        print("Enter target floor (G, 1, 2, 3) or 'q' to quit: ", end="", flush=True)
                else:
                    # Print ESP32 event messages (commands acknowledged, motor moves, target reached)
                    print(f"\n[ESP32] {line}")
                    print("Enter target floor (G, 1, 2, 3) or 'q' to quit: ", end="", flush=True)
            else:
                time.sleep(0.02)
        except Exception as e:
            if not stop_event.is_set():
                print(f"\n[Error reading serial]: {e}")
            break


def list_serial_ports():
    return serial.tools.list_ports.comports()


def select_serial_port() -> str | None:
    ports = list_serial_ports()
    if not ports:
        print("No active serial (COM) ports found!")
        manual = input("Enter COM port manually (e.g. COM7) or 'sim' for simulation mode: ").strip()
        return manual if manual else None

    print("\n--- Available Serial Ports ---")
    for idx, p in enumerate(ports):
        print(f"  [{idx + 1}] {p.device} - {p.description}")

    if len(ports) == 1:
        choice = input(f"Connect to {ports[0].device}? ([Y]/n/manual): ").strip().lower()
        if choice in ("", "y", "yes"):
            return ports[0].device
        elif choice == "manual":
            return input("Enter COM port: ").strip()

    while True:
        sel = input("Select port number (or type COM port name / 'sim' for simulation): ").strip()
        if sel.lower() == "sim":
            return "sim"
        if sel.isdigit() and 1 <= int(sel) <= len(ports):
            return ports[int(sel) - 1].device
        elif sel.upper().startswith("COM") or sel.startswith("/dev/"):
            return sel
        print("Invalid selection. Try again.")


def main():
    print("=" * 55)
    print("          SMARTLIFT SERIAL CONTROLLER")
    print("=" * 55)

    port = select_serial_port()
    if not port or port.lower() == "sim":
        print("Exiting...")
        return

    print(f"\nConnecting to {port} at {BAUD_RATE} baud...")
    try:
        ser = serial.Serial(port, BAUD_RATE, timeout=1)
        time.sleep(1.5)  # Allow ESP32 reset upon serial connection
        ser.reset_input_buffer()
        print(f"Connected to {port} successfully!")
    except Exception as e:
        print(f"Could not open serial port {port}: {e}")
        return

    stop_event = threading.Event()
    state = {"current_floor": "Unknown", "last_sensors": {}}

    reader = threading.Thread(target=serial_reader_thread, args=(ser, stop_event, state), daemon=True)
    reader.start()

    print("\nLift control interface ready.")
    print("Valid commands: 'G', '1', '2', '3' (or 'q' to quit)\n")

    try:
        while True:
            cmd = input("Enter target floor (G, 1, 2, 3) or 'q' to quit: ").strip().upper()
            if not cmd:
                continue

            if cmd in ("Q", "QUIT", "EXIT"):
                print("Exiting...")
                break

            if cmd == "0":
                cmd = "G"

            if cmd in ("G", "1", "2", "3"):
                message = f"{cmd}\n"
                ser.write(message.encode("utf-8"))
                ser.flush()
                print(f"--> Sent Command to Lift: Move to Floor [{cmd}]")
            else:
                print(f"Invalid floor: '{cmd}'. Please enter G, 1, 2, or 3.")

    except KeyboardInterrupt:
        print("\nInterrupted by user.")
    finally:
        stop_event.set()
        time.sleep(0.2)
        if ser.is_open:
            ser.close()
            print("Serial connection closed.")


if __name__ == "__main__":
    main()

import type { KindleDevice } from "./values/kindle-device.js";
import { ValidationError, type Result, ok, err } from "./errors.js";

/** Implements FR-3: DeviceRegistry holds a validated collection of KindleDevice objects */
const MAX_DEVICES = 10;

export class DeviceRegistry {
  private readonly devices: ReadonlyMap<string, KindleDevice>;
  readonly defaultDevice: KindleDevice;

  private constructor(
    devices: ReadonlyMap<string, KindleDevice>,
    defaultDevice: KindleDevice,
  ) {
    this.devices = devices;
    this.defaultDevice = defaultDevice;
  }

  /**
   * Creates a DeviceRegistry from an array of KindleDevice objects.
   * Validates: non-empty, max 10, no duplicate names.
   * If defaultDeviceName is provided, it must match a device name (case-insensitive).
   * If omitted, the first device is used as the default.
   */
  static create(
    devices: ReadonlyArray<KindleDevice>,
    defaultDeviceName?: string,
  ): Result<DeviceRegistry, ValidationError> {
    if (devices.length === 0) {
      return err(
        new ValidationError(
          "devices",
          "At least one Kindle device must be configured.",
        ),
      );
    }

    if (devices.length > MAX_DEVICES) {
      return err(
        new ValidationError(
          "devices",
          `Too many devices: ${devices.length}. Maximum is ${MAX_DEVICES}.`,
        ),
      );
    }

    const map = new Map<string, KindleDevice>();
    for (const device of devices) {
      if (map.has(device.name)) {
        return err(
          new ValidationError(
            "devices",
            `Duplicate device name: '${device.name}'.`,
          ),
        );
      }
      map.set(device.name, device);
    }

    let resolvedDefault: KindleDevice;

    if (defaultDeviceName === undefined) {
      const firstDevice = devices[0];
      if (firstDevice === undefined) {
        // Unreachable: guarded by length check above, but satisfies noUncheckedIndexedAccess
        return err(
          new ValidationError("devices", "At least one Kindle device must be configured."),
        );
      }
      resolvedDefault = firstDevice;
    } else {
      const normalized = defaultDeviceName.trim().toLowerCase();
      const found = map.get(normalized);
      if (found === undefined) {
        return err(
          new ValidationError(
            "KINDLE_DEFAULT_DEVICE",
            `Default device '${defaultDeviceName}' not found. Available: ${[...map.keys()].join(", ")}.`,
          ),
        );
      }
      resolvedDefault = found;
    }

    return ok(new DeviceRegistry(map, resolvedDefault));
  }

  /**
   * Resolves a device by name (case-insensitive).
   * If name is undefined, returns the default device.
   * Returns ValidationError if the name is unknown; error message lists device names only (no emails).
   */
  resolve(name?: string): Result<KindleDevice, ValidationError> {
    if (name === undefined) {
      return ok(this.defaultDevice);
    }

    const normalized = name.trim().toLowerCase();
    const device = this.devices.get(normalized);

    if (device === undefined) {
      const available = [...this.devices.keys()].join(", ");
      return err(
        new ValidationError(
          "device",
          `Unknown device '${name}'. Available devices: ${available}.`,
        ),
      );
    }

    return ok(device);
  }

  /** Returns all registered device names in insertion order. */
  get names(): ReadonlyArray<string> {
    return [...this.devices.keys()];
  }
}

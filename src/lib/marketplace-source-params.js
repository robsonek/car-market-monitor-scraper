// Static schema for the source marketplace's `advert.parametersDict` — every parameter we know
// how to flatten into a typed SQLite column. Each entry is `[paramKey, columnName, type]`:
//
//   paramKey   — the key as it appears in advert.parametersDict
//   columnName — the SQL column name (renamed where the raw key would be a
//                bad identifier, e.g. starts with a digit, or where the raw
//                key is verbose)
//   type       — one of "TEXT" | "INT" | "REAL" | "BOOL"
//                BOOL params have value "1"/"0" in the source; we map them to
//                INTEGER 1/0/null. INT/REAL params get parsed numerically. TEXT
//                params get the raw `value` string (the slug, not the human label).
//
// Source of truth: enumerated from a sample listing's parameters dict (152 keys
// observed). Adding a new param here REQUIRES adding the matching ALTER TABLE
// in a new migration — the two must stay in lockstep.
//
// VIN, registration and date_registration are NOT in this list — they're
// handled separately in normalizeDetail(). The `damaged`/`no_accident`/
// `service_record`/etc. condition fields ARE listed
// here (BOOL) — they come from migration 0002 and are now populated through
// the same params pipeline as everything else (legacy extractCondition() still
// produces identical output for backwards compat).

export const PARAMS = [
  // ----- Vehicle core -----
  ["make", "make", "TEXT"],
  ["model", "model", "TEXT"],
  ["year", "year", "INT"],
  ["mileage", "mileage", "INT"],
  ["body_type", "body_type", "TEXT"],
  ["color", "color", "TEXT"],
  ["colour_type", "colour_type", "TEXT"],
  ["door_count", "door_count", "INT"],
  ["nr_seats", "nr_seats", "INT"],
  ["upholstery_type", "upholstery_type", "TEXT"],
  ["rhd", "rhd", "BOOL"],
  ["has_vin", "has_vin", "BOOL"],
  ["has_registration", "has_registration", "BOOL"],

  // ----- Powertrain -----
  ["fuel_type", "fuel_type", "TEXT"],
  ["engine_power", "engine_power", "INT"],
  ["engine_capacity", "engine_capacity", "INT"],
  ["gearbox", "gearbox", "TEXT"],
  ["transmission", "transmission", "TEXT"],

  // ----- EV-specific -----
  ["autonomy", "autonomy", "INT"],
  ["avg_consumption", "avg_consumption", "REAL"],
  ["battery_capacity", "battery_capacity", "REAL"],
  ["battery_type", "battery_type", "TEXT"],
  ["electric_power_peak", "electric_power_peak", "INT"],
  ["brake_energy_recovery", "brake_energy_recovery", "TEXT"],
  ["energy_recovery_system", "energy_recovery_system", "BOOL"],
  ["quick_charging_function", "quick_charging_function", "BOOL"],
  ["vehicle_charging_cable", "vehicle_charging_cable", "BOOL"],

  // ----- Condition / origin (also defined in migration 0002, kept here for
  //       single-source-of-truth extraction) -----
  ["damaged", "damaged", "BOOL"],
  ["no_accident", "no_accident", "BOOL"],
  ["service_record", "service_record", "BOOL"],
  ["original_owner", "original_owner", "BOOL"],
  ["is_imported_car", "is_imported_car", "BOOL"],
  ["tuning", "tuning", "BOOL"],
  ["historical_vehicle", "historical_vehicle", "BOOL"],
  ["registered", "registered", "BOOL"],
  ["new_used", "new_used", "TEXT"],
  ["country_origin", "country_origin", "TEXT"],

  // ----- Safety (boolean) -----
  ["antilock_brake_system", "abs", "BOOL"],
  ["traction_control", "traction_control", "BOOL"],
  ["esp", "esp", "BOOL"],
  ["brake_assist", "brake_assist", "BOOL"],
  ["power_assisted_brakes", "power_assisted_brakes", "BOOL"],
  ["distribution_of_braking_force_electronically", "distribution_of_braking_force_electronically", "BOOL"],
  ["driver_airbag", "driver_airbag", "BOOL"],
  ["passenger_airbag", "passenger_airbag", "BOOL"],
  ["side_airbag_driver_and_passenger", "side_airbag_driver_and_passenger", "BOOL"],
  ["head_airbags_front", "head_airbags_front", "BOOL"],
  ["head_airbags_rear", "head_airbags_rear", "BOOL"],
  ["knee_airbag_driver", "knee_airbag_driver", "BOOL"],
  ["knee_airbag_passenger", "knee_airbag_passenger", "BOOL"],
  ["pre_crash_system", "pre_crash_system", "BOOL"],
  ["rear_pre_crash_system", "rear_pre_crash_system", "BOOL"],
  ["side_pre_crash_system", "side_pre_crash_system", "BOOL"],
  ["pre_crash_sound_system", "pre_crash_sound_system", "BOOL"],
  ["active_emergency_brake_assist", "active_emergency_brake_assist", "BOOL"],
  ["city_emergency_brake_assist", "city_emergency_brake_assist", "BOOL"],
  ["pedestrian_emergency_brake_assist", "pedestrian_emergency_brake_assist", "BOOL"],
  ["roll_over_protection_system", "roll_over_protection_system", "BOOL"],
  ["child_seat_fixation", "child_seat_fixation", "BOOL"],
  ["blind_spot_warning", "blind_spot_warning", "BOOL"],
  ["collision_warning_system", "collision_warning_system", "BOOL"],
  ["automatic_emergency_call", "automatic_emergency_call", "BOOL"],
  ["acoustic_vehicle_alerting_system", "acoustic_vehicle_alerting_system", "BOOL"],
  ["tyre_pressure_control", "tyre_pressure_control", "BOOL"],

  // ----- Comfort -----
  ["air_conditioning_type", "air_conditioning_type", "TEXT"],
  ["air_condition_rear", "air_condition_rear", "BOOL"],
  ["automatic_heating_control", "automatic_heating_control", "BOOL"],
  ["independent_vehicle_heater", "independent_vehicle_heater", "BOOL"],
  ["windscreen_heating", "windscreen_heating", "BOOL"],
  ["air_suspension", "air_suspension", "BOOL"],
  ["adjustable_suspension", "adjustable_suspension", "BOOL"],
  ["comfort_suspension", "comfort_suspension", "BOOL"],
  ["sport_suspension", "sport_suspension", "BOOL"],
  ["hydro_pneumatic_suspension", "hydro_pneumatic_suspension", "BOOL"],
  ["electronic_controlled_suspension", "electronic_controlled_suspension", "BOOL"],
  ["heated_seat_driver", "heated_seat_driver", "BOOL"],
  ["heated_seat_passenger", "heated_seat_passenger", "BOOL"],
  ["ventilated_front_seat", "ventilated_front_seat", "BOOL"],
  ["sport_seats_front", "sport_seats_front", "BOOL"],
  ["driver_seat_electrically_adjustable", "driver_seat_electrically_adjustable", "BOOL"],
  ["passenger_seat_electrically_adjustable", "passenger_seat_electrically_adjustable", "BOOL"],
  ["memory_seat", "memory_seat", "BOOL"],
  ["lumbar_adjust_driver_electric", "lumbar_adjust_driver_electric", "BOOL"],
  ["lumbar_adjust_passenger_electric", "lumbar_adjust_passenger_electric", "BOOL"],
  ["power_windows_front", "power_windows_front", "BOOL"],
  ["power_windows_rear", "power_windows_rear", "BOOL"],
  ["power_steering", "power_steering", "BOOL"],
  ["steering_wheel_heated", "steering_wheel_heated", "BOOL"],
  ["steering_wheel_electrically_adjustable", "steering_wheel_electrically_adjustable", "BOOL"],
  ["steering_wheel_with_radio_operation", "steering_wheel_with_radio_operation", "BOOL"],
  ["multi_functional_steering_wheel", "multi_functional_steering_wheel", "BOOL"],
  ["sports_steering_wheel", "sports_steering_wheel", "BOOL"],
  ["leather_steering_wheel", "leather_steering_wheel", "BOOL"],
  ["armrest_front", "armrest_front", "BOOL"],
  ["armrest_rear", "armrest_rear", "BOOL"],
  ["sunroof", "sunroof", "TEXT"],
  ["tinted_rear_windows", "tinted_rear_windows", "BOOL"],
  ["approval_for_goods", "approval_for_goods", "BOOL"],
  ["cant_see_my_version", "cant_see_my_version", "BOOL"],
  ["autorenew", "autorenew", "BOOL"],

  // ----- Tech / infotainment -----
  ["navigation_system", "navigation_system", "BOOL"],
  ["radio", "radio", "BOOL"],
  ["touchscreen_monitor", "touchscreen_monitor", "BOOL"],
  ["internet_access", "internet_access", "BOOL"],
  ["android_auto", "android_auto", "BOOL"],
  ["apple_carplay", "apple_carplay", "BOOL"],
  ["bluetooth_interface", "bluetooth_interface", "BOOL"],
  ["hands_free_system", "hands_free_system", "BOOL"],
  ["voice_control_for_vehicle_functions", "voice_control_for_vehicle_functions", "BOOL"],
  ["usb_in", "usb_in", "BOOL"],
  ["wireless_device_charging", "wireless_device_charging", "BOOL"],
  ["soundsystem", "soundsystem", "BOOL"],
  ["keyless_engine_start", "keyless_engine_start", "BOOL"],
  ["startstop_system", "startstop_system", "BOOL"],
  ["digital_key", "digital_key", "BOOL"],
  ["electric_parking_brake", "electric_parking_brake", "BOOL"],

  // ----- Driver assist -----
  ["cruisecontrol_type", "cruisecontrol_type", "TEXT"],
  ["lane_control_assistant", "lane_control_assistant", "BOOL"],
  ["active_lane_change_assistant", "active_lane_change_assistant", "BOOL"],
  ["distance_control", "distance_control", "BOOL"],
  ["traffic_sign_recognition", "traffic_sign_recognition", "BOOL"],
  ["curve_trace_assistant", "curve_trace_assistant", "BOOL"],
  ["speed_limiter", "speed_limiter", "BOOL"],
  ["park_assistant", "park_assistant", "BOOL"],
  ["park_distance_control_front", "park_distance_control_front", "BOOL"],
  ["park_distance_control_rear", "park_distance_control_rear", "BOOL"],
  ["autonomous_parking_system", "autonomous_parking_system", "BOOL"],

  // ----- Lighting -----
  ["headlight_lamp_type", "headlight_lamp_type", "TEXT"],
  ["adaptive_light", "adaptive_light", "BOOL"],
  ["cornering_headlights", "cornering_headlights", "BOOL"],
  ["dynamic_directional_lights", "dynamic_directional_lights", "BOOL"],
  ["daytime_running_lights", "daytime_running_lights", "BOOL"],
  ["led_daytime_running_lights", "led_daytime_running_lights", "BOOL"],
  ["automated_high_beam_assist", "automated_high_beam_assist", "BOOL"],
  ["automatic_dimlight_activation", "automatic_dimlight_activation", "BOOL"],
  ["follow_me_home", "follow_me_home", "BOOL"],
  ["fog_lamps", "fog_lamps", "BOOL"],
  ["led_interior_lighting", "led_interior_lighting", "BOOL"],
  ["rain_sensor", "rain_sensor", "BOOL"],

  // ----- Mirrors / cameras -----
  ["door_mirror_electrically_adjustable_in_general", "door_mirror_electrically_adjustable_in_general", "BOOL"],
  ["door_mirrors_electrically_foldable", "door_mirrors_electrically_foldable", "BOOL"],
  ["door_mirrors_heated", "door_mirrors_heated", "BOOL"],
  ["door_mirror_camera", "door_mirror_camera", "BOOL"],
  ["rear_view_camera", "rear_view_camera", "BOOL"],
  // Param key starts with a digit ("360_view_camera") which is awkward as an
  // identifier; remap to a name we can use unquoted everywhere.
  ["360_view_camera", "view_360_camera", "BOOL"],

  // ----- Wheels / tires / brakes -----
  ["alloy_wheels_type", "alloy_wheels_type", "TEXT"],
  ["tyre_type", "tyre_type", "TEXT"],
  ["ceramic_composite_brakes", "ceramic_composite_brakes", "BOOL"],
  ["particle_filter", "particle_filter", "BOOL"],
  ["windscreenwiper_other", "windscreenwiper_other", "BOOL"],
];

// All column names in the same order as PARAMS — used by scrape.js to build
// INSERT/UPDATE statements. Exported as a frozen array so consumers don't
// accidentally mutate it.
export const PARAM_COLUMNS = Object.freeze(PARAMS.map(([, col]) => col));

// Walks parametersDict and produces a flat object keyed by column name with
// type-converted values. Missing params get null. Unknown params (not in PARAMS)
// are silently ignored — they live on in payload_json for forensics but don't
// pollute listings columns. To start tracking a new param: add it to PARAMS AND
// add an ALTER TABLE in a new migration.
export function extractParams(parametersDict) {
  const out = {};
  for (const [key, column, type] of PARAMS) {
    const raw = parametersDict?.[key]?.values?.[0]?.value;
    out[column] = convertValue(raw, type);
  }
  return out;
}

function convertValue(raw, type) {
  if (raw == null || raw === "") return null;
  switch (type) {
    case "BOOL":
      // Source values are strings "1" / "0". Anything else (e.g. "Tak"/"Nie"
      // from the label field — wrong column) collapses to null so we don't
      // accidentally store garbage that looks like 1.
      if (raw === "1") return 1;
      if (raw === "0") return 0;
      return null;
    case "INT": {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    }
    case "REAL": {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) ? n : null;
    }
    case "TEXT":
    default:
      return String(raw);
  }
}

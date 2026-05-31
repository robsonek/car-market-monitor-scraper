-- Consolidated schema. Historia migracji została spłaszczona do jednego pliku —
-- baza jest wyczyszczana i odbudowywana od zera przy każdym istotnym przejściu,
-- zamiast utrzymywać ewoluujące ALTER TABLE. Jeśli musisz zmienić kształt, zrób
-- to in-place tutaj i powiedz użytkownikom żeby usunęli plik bazy.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  name TEXT,
  url TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,
  last_success_at TEXT
);

-- One row per scrape pass for a source. Each row is written atomically at
-- the end of the pass — there are no intermediate states because the whole
-- pass runs inside a single better-sqlite3 transaction. If the process dies
-- mid-pass, the row simply never gets inserted, and the next workflow run
-- starts cleanly.
CREATE TABLE IF NOT EXISTS scrape_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  batch_id TEXT,
  reported_total_count INTEGER,
  raw_row_count INTEGER,
  unique_row_count INTEGER,
  detail_success_count INTEGER NOT NULL DEFAULT 0,
  detail_failed_count INTEGER NOT NULL DEFAULT 0,
  new_listings_count INTEGER NOT NULL DEFAULT 0,
  changed_listings_count INTEGER NOT NULL DEFAULT 0,
  unchanged_listings_count INTEGER NOT NULL DEFAULT 0,
  removed_listings_count INTEGER NOT NULL DEFAULT 0,
  reactivated_listings_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  listing_url TEXT NOT NULL,
  title TEXT,
  seller_type TEXT,
  current_status TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_snapshot_id TEXT,
  last_snapshot_hash TEXT,
  last_price_amount TEXT,
  last_mileage TEXT,
  last_year TEXT,
  -- Hysteresis dla wykrywania zniknięć: zamiast flipować is_active na 0
  -- po pierwszym nietrafionym scanie, bumpujemy ten licznik i flipujemy
  -- dopiero po MISSING_THRESHOLD kolejnych miss'ach (patrz scrape.js).
  missed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  -- Stan i historia pojazdu — deklaracje sprzedawcy z parametersDict.
  -- Denormalizowane do osobnych kolumn żeby dało się po nich filtrować
  -- w dashboardzie bez parsowania payload_json za każdym razem.
  damaged INTEGER,
  no_accident INTEGER,
  service_record INTEGER,
  original_owner INTEGER,
  is_imported_car INTEGER,
  tuning INTEGER,
  historical_vehicle INTEGER,
  registered INTEGER,
  new_used TEXT,
  country_origin TEXT,

  -- Seller info.
  seller_uuid TEXT,
  seller_id TEXT,
  seller_name TEXT,
  seller_location_city TEXT,
  seller_location_region TEXT,
  seller_location_lat REAL,
  seller_location_lon REAL,

  -- Marketplace-side timestamps. advert_created_at = pierwotny post,
  -- advert_updated_at = ostatni touch upstream, advert_original_created_at =
  -- przeżywa republishes.
  advert_created_at TEXT,
  advert_updated_at TEXT,
  advert_original_created_at TEXT,

  -- Price metadata beyond the bare amount already in last_price_amount.
  price_currency TEXT,
  price_labels_json TEXT,

  -- Identification / contact. NULLable bo nie każdy sprzedawca je wystawia.
  vin TEXT,
  registration TEXT,
  date_registration TEXT,
  -- phones_json shape: {"main":["509322008",...],"description":["694512812",...]}
  phones_json TEXT,

  image_count INTEGER,

  -- Verified-car / vehicle-class flags from the advert root.
  verified_car INTEGER,
  is_used_car INTEGER,
  is_parts INTEGER,

  -- Kolumny parametryczne odpowiadające PARAM_COLUMNS w
  -- src/lib/marketplace-source-params.js. Obie listy MUSZĄ zostać zsynchronizowane.

  -- Vehicle core
  make TEXT,
  model TEXT,
  year INTEGER,
  mileage INTEGER,
  body_type TEXT,
  color TEXT,
  colour_type TEXT,
  door_count INTEGER,
  nr_seats INTEGER,
  upholstery_type TEXT,
  rhd INTEGER,
  has_vin INTEGER,
  has_registration INTEGER,

  -- Powertrain
  fuel_type TEXT,
  engine_power INTEGER,
  engine_capacity INTEGER,
  gearbox TEXT,
  transmission TEXT,

  -- EV-specific
  autonomy INTEGER,
  avg_consumption REAL,
  battery_capacity REAL,
  battery_type TEXT,
  electric_power_peak INTEGER,
  brake_energy_recovery TEXT,
  energy_recovery_system INTEGER,
  quick_charging_function INTEGER,
  vehicle_charging_cable INTEGER,

  -- Safety
  abs INTEGER,
  traction_control INTEGER,
  esp INTEGER,
  brake_assist INTEGER,
  power_assisted_brakes INTEGER,
  distribution_of_braking_force_electronically INTEGER,
  driver_airbag INTEGER,
  passenger_airbag INTEGER,
  side_airbag_driver_and_passenger INTEGER,
  head_airbags_front INTEGER,
  head_airbags_rear INTEGER,
  knee_airbag_driver INTEGER,
  knee_airbag_passenger INTEGER,
  pre_crash_system INTEGER,
  rear_pre_crash_system INTEGER,
  side_pre_crash_system INTEGER,
  pre_crash_sound_system INTEGER,
  active_emergency_brake_assist INTEGER,
  city_emergency_brake_assist INTEGER,
  pedestrian_emergency_brake_assist INTEGER,
  roll_over_protection_system INTEGER,
  child_seat_fixation INTEGER,
  blind_spot_warning INTEGER,
  collision_warning_system INTEGER,
  automatic_emergency_call INTEGER,
  acoustic_vehicle_alerting_system INTEGER,
  tyre_pressure_control INTEGER,

  -- Comfort
  air_conditioning_type TEXT,
  air_condition_rear INTEGER,
  automatic_heating_control INTEGER,
  independent_vehicle_heater INTEGER,
  windscreen_heating INTEGER,
  air_suspension INTEGER,
  adjustable_suspension INTEGER,
  comfort_suspension INTEGER,
  sport_suspension INTEGER,
  hydro_pneumatic_suspension INTEGER,
  electronic_controlled_suspension INTEGER,
  heated_seat_driver INTEGER,
  heated_seat_passenger INTEGER,
  ventilated_front_seat INTEGER,
  sport_seats_front INTEGER,
  driver_seat_electrically_adjustable INTEGER,
  passenger_seat_electrically_adjustable INTEGER,
  memory_seat INTEGER,
  lumbar_adjust_driver_electric INTEGER,
  lumbar_adjust_passenger_electric INTEGER,
  power_windows_front INTEGER,
  power_windows_rear INTEGER,
  power_steering INTEGER,
  steering_wheel_heated INTEGER,
  steering_wheel_electrically_adjustable INTEGER,
  steering_wheel_with_radio_operation INTEGER,
  multi_functional_steering_wheel INTEGER,
  sports_steering_wheel INTEGER,
  leather_steering_wheel INTEGER,
  armrest_front INTEGER,
  armrest_rear INTEGER,
  sunroof TEXT,
  tinted_rear_windows INTEGER,
  approval_for_goods INTEGER,
  cant_see_my_version INTEGER,
  autorenew INTEGER,

  -- Tech / infotainment
  navigation_system INTEGER,
  radio INTEGER,
  touchscreen_monitor INTEGER,
  internet_access INTEGER,
  android_auto INTEGER,
  apple_carplay INTEGER,
  bluetooth_interface INTEGER,
  hands_free_system INTEGER,
  voice_control_for_vehicle_functions INTEGER,
  usb_in INTEGER,
  wireless_device_charging INTEGER,
  soundsystem INTEGER,
  keyless_engine_start INTEGER,
  startstop_system INTEGER,
  digital_key INTEGER,
  electric_parking_brake INTEGER,

  -- Driver assist
  cruisecontrol_type TEXT,
  lane_control_assistant INTEGER,
  active_lane_change_assistant INTEGER,
  distance_control INTEGER,
  traffic_sign_recognition INTEGER,
  curve_trace_assistant INTEGER,
  speed_limiter INTEGER,
  park_assistant INTEGER,
  park_distance_control_front INTEGER,
  park_distance_control_rear INTEGER,
  autonomous_parking_system INTEGER,

  -- Lighting
  headlight_lamp_type TEXT,
  adaptive_light INTEGER,
  cornering_headlights INTEGER,
  dynamic_directional_lights INTEGER,
  daytime_running_lights INTEGER,
  led_daytime_running_lights INTEGER,
  automated_high_beam_assist INTEGER,
  automatic_dimlight_activation INTEGER,
  follow_me_home INTEGER,
  fog_lamps INTEGER,
  led_interior_lighting INTEGER,
  rain_sensor INTEGER,

  -- Mirrors / cameras (view_360_camera = renamed z oryginalnego `360_view_camera`
  -- które zaczyna się od cyfry)
  door_mirror_electrically_adjustable_in_general INTEGER,
  door_mirrors_electrically_foldable INTEGER,
  door_mirrors_heated INTEGER,
  door_mirror_camera INTEGER,
  rear_view_camera INTEGER,
  view_360_camera INTEGER,

  -- Wheels / tires / brakes
  alloy_wheels_type TEXT,
  tyre_type TEXT,
  ceramic_composite_brakes INTEGER,
  particle_filter INTEGER,
  windscreenwiper_other INTEGER,

  UNIQUE (source_id, external_id),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

-- listing_snapshots: pełny payload znormalizowanego detala per scrape pass.
-- Opis sprzedawcy żyje wyłącznie w payload_json.description_html (po
-- sanitizacji + rozwiązaniu phoneNumber tokenów przy ingest'cie). Plain text
-- dla diffów i search jest derywowany w locie przez stripHtml — nie ma osobnej
-- kolumny, nie ma duplikacji.
CREATE TABLE IF NOT EXISTS listing_snapshots (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  title TEXT,
  price_amount TEXT,
  mileage TEXT,
  year TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE (listing_id, run_id),
  FOREIGN KEY (listing_id) REFERENCES listings(id),
  FOREIGN KEY (run_id) REFERENCES scrape_runs(id)
);

CREATE TABLE IF NOT EXISTS listing_changes (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_id TEXT,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (listing_id) REFERENCES listings(id),
  FOREIGN KEY (run_id) REFERENCES scrape_runs(id),
  FOREIGN KEY (snapshot_id) REFERENCES listing_snapshots(id)
);

-- ---------- relisting detection ----------
-- Powiazania miedzy ogloszeniami tego samego pojazdu wystawionymi pod
-- roznymi external_id (sprzedawca zakonczyl i wystawil ponownie).

CREATE TABLE IF NOT EXISTS listing_relistings (
  id TEXT PRIMARY KEY,
  old_listing_id TEXT NOT NULL,
  new_listing_id TEXT NOT NULL,
  match_type TEXT NOT NULL,       -- 'vin', 'registration', 'fuzzy'
  match_details TEXT,             -- JSON: {"vin":"WBA..."} lub {"make":"porsche","model":"taycan",...}
  detected_at TEXT NOT NULL,
  run_id TEXT,                    -- NULL dla retroaktywnego wykrycia
  UNIQUE (old_listing_id, new_listing_id),
  FOREIGN KEY (old_listing_id) REFERENCES listings(id),
  FOREIGN KEY (new_listing_id) REFERENCES listings(id)
);

CREATE INDEX IF NOT EXISTS idx_sources_active ON sources(is_active);
CREATE INDEX IF NOT EXISTS idx_runs_source_started ON scrape_runs(source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_batch_started ON scrape_runs(batch_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_source_active ON listings(source_id, is_active);
CREATE INDEX IF NOT EXISTS idx_listings_vin ON listings(vin);
CREATE INDEX IF NOT EXISTS idx_listings_seller_uuid ON listings(seller_uuid);
CREATE INDEX IF NOT EXISTS idx_listings_make_model ON listings(make, model);
CREATE INDEX IF NOT EXISTS idx_listings_year ON listings(year);
CREATE INDEX IF NOT EXISTS idx_listings_mileage ON listings(mileage);
CREATE INDEX IF NOT EXISTS idx_listings_fuel_type ON listings(fuel_type);
CREATE INDEX IF NOT EXISTS idx_snapshots_listing_captured ON listing_snapshots(listing_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_listing_created ON listing_changes(listing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_relistings_old ON listing_relistings(old_listing_id);
CREATE INDEX IF NOT EXISTS idx_relistings_new ON listing_relistings(new_listing_id);
CREATE INDEX IF NOT EXISTS idx_relistings_detected ON listing_relistings(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_registration ON listings(registration);

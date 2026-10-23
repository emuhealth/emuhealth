// A synthetic REDCap project: a data dictionary with two instruments and generated records.

export type Row = Record<string, string>;

export interface Field {
  field_name: string;
  form_name: string;
  section_header: string;
  field_type: string;
  field_label: string;
  select_choices_or_calculations: string;
  field_note: string;
  text_validation_type_or_show_slider_number: string;
  text_validation_min: string;
  text_validation_max: string;
  identifier: string;
  branching_logic: string;
  required_field: string;
  custom_alignment: string;
  question_number: string;
  matrix_group_name: string;
  matrix_ranking: string;
  field_annotation: string;
}

export interface Project {
  info: Record<string, string | number>;
  instruments: Array<{ instrument_name: string; instrument_label: string }>;
  metadata: Field[];
  records: Row[];
}

export interface GenerateOptions {
  /** Records, 0 to 5000. Default 20. */
  records?: number;
  /** PRNG seed. Default 1. */
  seed?: number;
}

const field = (f: Partial<Field> & Pick<Field, "field_name" | "form_name" | "field_type" | "field_label">): Field => ({
  section_header: "",
  select_choices_or_calculations: "",
  field_note: "",
  text_validation_type_or_show_slider_number: "",
  text_validation_min: "",
  text_validation_max: "",
  identifier: "",
  branching_logic: "",
  required_field: "",
  custom_alignment: "",
  question_number: "",
  matrix_group_name: "",
  matrix_ranking: "",
  field_annotation: "",
  ...f,
});

export const METADATA: Field[] = [
  field({ field_name: "record_id", form_name: "demographics", field_type: "text", field_label: "Record ID" }),
  field({
    field_name: "dob",
    form_name: "demographics",
    field_type: "text",
    field_label: "Date of birth",
    text_validation_type_or_show_slider_number: "date_ymd",
    identifier: "y",
  }),
  field({
    field_name: "sex",
    form_name: "demographics",
    field_type: "radio",
    field_label: "Sex",
    select_choices_or_calculations: "1, Female | 2, Male",
    required_field: "y",
  }),
  field({
    field_name: "race",
    form_name: "demographics",
    field_type: "checkbox",
    field_label: "Race",
    select_choices_or_calculations:
      "1, American Indian or Alaska Native | 2, Asian | 3, Black or African American | 4, Native Hawaiian or Other Pacific Islander | 5, White",
  }),
  field({
    field_name: "height",
    form_name: "demographics",
    field_type: "text",
    field_label: "Height (cm)",
    text_validation_type_or_show_slider_number: "number",
    text_validation_min: "100",
    text_validation_max: "220",
  }),
  field({
    field_name: "weight",
    form_name: "demographics",
    field_type: "text",
    field_label: "Weight (kg)",
    text_validation_type_or_show_slider_number: "number",
    text_validation_min: "30",
    text_validation_max: "250",
  }),
  field({
    field_name: "bmi",
    form_name: "demographics",
    field_type: "calc",
    field_label: "BMI",
    select_choices_or_calculations: "round([weight]/(([height]/100)^2),1)",
  }),
  field({
    field_name: "visit_date",
    form_name: "visit",
    field_type: "text",
    field_label: "Visit date",
    text_validation_type_or_show_slider_number: "date_ymd",
  }),
  field({
    field_name: "sbp",
    form_name: "visit",
    field_type: "text",
    field_label: "Systolic blood pressure (mmHg)",
    text_validation_type_or_show_slider_number: "integer",
  }),
  field({
    field_name: "dbp",
    form_name: "visit",
    field_type: "text",
    field_label: "Diastolic blood pressure (mmHg)",
    text_validation_type_or_show_slider_number: "integer",
  }),
  field({
    field_name: "medication",
    form_name: "visit",
    field_type: "dropdown",
    field_label: "Antihypertensive medication",
    select_choices_or_calculations: "0, None | 1, Lisinopril | 2, Amlodipine | 3, Hydrochlorothiazide",
  }),
  field({
    field_name: "adverse_event",
    form_name: "visit",
    field_type: "yesno",
    field_label: "Adverse event since last visit?",
  }),
  field({
    field_name: "ae_description",
    form_name: "visit",
    field_type: "notes",
    field_label: "Describe the adverse event",
    branching_logic: "[adverse_event] = '1'",
  }),
];

export const INSTRUMENTS = [
  { instrument_name: "demographics", instrument_label: "Demographics" },
  { instrument_name: "visit", instrument_label: "Visit" },
];

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function generateProject(options: GenerateOptions = {}): Project {
  const count = options.records ?? 20;
  const seed = options.seed ?? 1;
  if (!Number.isInteger(count) || count < 0 || count > 5000)
    throw new Error("redcap.generate.records must be an integer from 0 to 5000");
  if (!Number.isInteger(seed)) throw new Error("redcap.generate.seed must be an integer");
  const random = prng(seed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const records: Row[] = [];
  for (let n = 1; n <= count; n++) {
    const sex = int(1, 2);
    const height = sex === 1 ? int(152, 175) : int(165, 190);
    const weight = int(55, 110);
    const race = int(1, 5);
    const ae = random() < 0.2;
    records.push({
      record_id: String(n),
      dob: date(Date.parse("1950-01-01") + int(0, 18000) * 86_400_000),
      sex: String(sex),
      ...Object.fromEntries([1, 2, 3, 4, 5].map((r) => [`race___${r}`, r === race ? "1" : "0"])),
      height: String(height),
      weight: String(weight),
      bmi: (weight / (height / 100) ** 2).toFixed(1),
      demographics_complete: "2",
      visit_date: date(Date.parse("2025-01-01") + int(0, 330) * 86_400_000),
      sbp: String(int(110, 165)),
      dbp: String(int(65, 100)),
      medication: String(int(0, 3)),
      adverse_event: ae ? "1" : "0",
      ae_description: ae ? "Synthetic adverse event: mild dizziness." : "",
      visit_complete: String(int(0, 2)),
    });
  }
  return {
    info: {
      project_id: 1,
      project_title: "Synthetic Hypertension Registry",
      creation_time: "2025-01-01 09:00:00",
      production_time: "",
      in_production: 0,
      project_language: "English",
      purpose: 4,
      purpose_other: "",
      project_notes: "Synthetic project generated by emuhealth. No real participants.",
      custom_record_label: "",
      secondary_unique_field: "",
      is_longitudinal: 0,
      has_repeating_instruments_or_events: 0,
      surveys_enabled: 0,
      scheduling_enabled: 0,
      record_autonumbering_enabled: 1,
      randomization_enabled: 0,
      ddp_enabled: 0,
      project_irb_number: "",
      project_grant_number: "",
      project_pi_firstname: "Synthetic",
      project_pi_lastname: "Investigator",
      display_today_now_button: 1,
      missing_data_codes: "",
      external_modules: "",
      bypass_branching_erase_field_prompt: 0,
    },
    instruments: INSTRUMENTS.map((i) => ({ ...i })),
    metadata: METADATA.map((f) => ({ ...f })),
    records,
  };
}

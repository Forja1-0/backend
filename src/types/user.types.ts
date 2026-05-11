export interface User {
  id: string;
  name: string | null;
  age: number | null;
  sex: "M" | "F" | "X" | null;
  weight_kg: number | null;
  height_cm: number | null;
  body_fat_pct: number | null;
  email: string | null;
  phone_wa: string | null;
  wa_chat_id: string | null;
  timezone: string;
  active: boolean;
  onboarding_step: number;
  created_at: Date;
  updated_at: Date;
}

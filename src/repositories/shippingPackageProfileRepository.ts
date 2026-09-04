import { randomUUID } from "node:crypto";
import { AppDatabase } from "../db/database";

export interface ShippingPackageProfile {
  id: string;
  name: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ShippingPackageProfileRow {
  id: string;
  name: string;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  weight_kg: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export class ShippingPackageProfileRepository {
  constructor(private readonly db: AppDatabase) {}

  async listProfiles(): Promise<ShippingPackageProfile[]> {
    const rows = await this.db.all<ShippingPackageProfileRow[]>(`
      SELECT id, name, length_cm, width_cm, height_cm, weight_kg, is_default, created_at, updated_at
      FROM shipping_package_profiles
      ORDER BY datetime(created_at) ASC
    `);

    return rows.map((row) => this.mapRow(row));
  }

  async getDefaultProfile(): Promise<ShippingPackageProfile | null> {
    const row = await this.db.get<ShippingPackageProfileRow>(`
      SELECT id, name, length_cm, width_cm, height_cm, weight_kg, is_default, created_at, updated_at
      FROM shipping_package_profiles
      WHERE is_default = 1
      ORDER BY datetime(updated_at) DESC
      LIMIT 1
    `);

    return row ? this.mapRow(row) : null;
  }

  async createProfile(input: {
    name: string;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    weightKg: number;
    setAsDefault?: boolean;
  }): Promise<ShippingPackageProfile> {
    const now = new Date().toISOString();
    const id = randomUUID();

    await this.db.exec("BEGIN");
    try {
      if (input.setAsDefault) {
        await this.db.run(`UPDATE shipping_package_profiles SET is_default = 0, updated_at = ?`, now);
      }

      await this.db.run(
        `
        INSERT INTO shipping_package_profiles (
          id,
          name,
          length_cm,
          width_cm,
          height_cm,
          weight_kg,
          is_default,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        id,
        input.name,
        input.lengthCm,
        input.widthCm,
        input.heightCm,
        input.weightKg,
        input.setAsDefault ? 1 : 0,
        now,
        now
      );

      await this.db.exec("COMMIT");
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }

    const created = await this.getById(id);
    if (!created) {
      throw new Error("Failed to create package profile.");
    }

    return created;
  }

  async setDefaultProfile(profileId: string): Promise<void> {
    const now = new Date().toISOString();

    await this.db.exec("BEGIN");
    try {
      await this.db.run(`UPDATE shipping_package_profiles SET is_default = 0, updated_at = ?`, now);
      const result = await this.db.run(
        `UPDATE shipping_package_profiles SET is_default = 1, updated_at = ? WHERE id = ?`,
        now,
        profileId
      );

      if ((result.changes ?? 0) !== 1) {
        throw new Error("Package profile not found.");
      }

      await this.db.exec("COMMIT");
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async ensureInitialDefaultFromEnv(defaults: {
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    weightKg: number;
  }): Promise<void> {
    const existing = await this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM shipping_package_profiles"
    );

    if ((existing?.count ?? 0) > 0) {
      return;
    }

    await this.createProfile({
      name: "Default Box",
      lengthCm: defaults.lengthCm,
      widthCm: defaults.widthCm,
      heightCm: defaults.heightCm,
      weightKg: defaults.weightKg,
      setAsDefault: true
    });
  }

  async getById(id: string): Promise<ShippingPackageProfile | null> {
    const row = await this.db.get<ShippingPackageProfileRow>(
      `
      SELECT id, name, length_cm, width_cm, height_cm, weight_kg, is_default, created_at, updated_at
      FROM shipping_package_profiles
      WHERE id = ?
      `,
      id
    );

    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: ShippingPackageProfileRow): ShippingPackageProfile {
    return {
      id: row.id,
      name: row.name,
      lengthCm: row.length_cm,
      widthCm: row.width_cm,
      heightCm: row.height_cm,
      weightKg: row.weight_kg,
      isDefault: row.is_default === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

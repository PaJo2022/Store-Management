import { ShippingPackageProfile, ShippingPackageProfileRepository } from "../../repositories/shippingPackageProfileRepository";

export interface DefaultPackageSpec {
  id: string | null;
  name: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
}

export class PackagingSettingsService {
  constructor(
    private readonly repository: ShippingPackageProfileRepository,
    private readonly fallback: {
      lengthCm: number;
      widthCm: number;
      heightCm: number;
      weightKg: number;
    }
  ) {}

  async initializeDefaults(): Promise<void> {
    await this.repository.ensureInitialDefaultFromEnv(this.fallback);
  }

  async listProfiles(): Promise<ShippingPackageProfile[]> {
    return this.repository.listProfiles();
  }

  async getProfileById(profileId: string): Promise<ShippingPackageProfile | null> {
    return this.repository.getById(profileId);
  }

  async createProfile(input: {
    name: string;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    weightKg: number;
    setAsDefault?: boolean;
  }): Promise<ShippingPackageProfile> {
    this.validateProfileInput(input);
    return this.repository.createProfile(input);
  }

  async setDefaultProfile(profileId: string): Promise<void> {
    if (!profileId || profileId.trim().length === 0) {
      throw new Error("profileId is required.");
    }

    await this.repository.setDefaultProfile(profileId.trim());
  }

  async getEffectiveDefaultPackage(): Promise<DefaultPackageSpec> {
    const profile = await this.repository.getDefaultProfile();
    if (!profile) {
      return {
        id: null,
        name: "Env Default",
        lengthCm: this.fallback.lengthCm,
        widthCm: this.fallback.widthCm,
        heightCm: this.fallback.heightCm,
        weightKg: this.fallback.weightKg
      };
    }

    return {
      id: profile.id,
      name: profile.name,
      lengthCm: profile.lengthCm,
      widthCm: profile.widthCm,
      heightCm: profile.heightCm,
      weightKg: profile.weightKg
    };
  }

  private validateProfileInput(input: {
    name: string;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    weightKg: number;
  }): void {
    if (!input.name || input.name.trim().length < 2) {
      throw new Error("Profile name must be at least 2 characters.");
    }

    const values = [input.lengthCm, input.widthCm, input.heightCm, input.weightKg];
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error("Dimensions and weight must be positive numbers.");
    }
  }
}

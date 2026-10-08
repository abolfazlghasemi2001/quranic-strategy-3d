/** Data-only character registry. It deliberately imports no renderer or gameplay code. */
import characterData from '../../data/characters.json';

export class CharacterRegistry {
  constructor(data = characterData) {
    this.data = data;
    this.models = new Map((data.models || []).map((model) => [model.id, model]));
    this.profiles = new Map((data.profiles || []).map((profile) => [profile.id, profile]));
    this.unitBindings = new Map(Object.entries(data.unitBindings || {}));
    this.selection = (data.selection || []).map((id) => this.profiles.get(id)).filter(Boolean);
    this._validate();
  }

  _validate() {
    if (this.data.version !== 1) throw new Error('Unsupported character registry version');
    if (!this.models.size || !this.profiles.size) throw new Error('Character registry must contain models and profiles');
    for (const model of this.models.values()) {
      if (!model.id || !model.asset || !model.asset.endsWith('.glb')) throw new Error(`Invalid GLB model definition: ${model.id || 'unknown'}`);
      if (!Number.isFinite(model.targetHeight) || model.targetHeight <= 0) throw new Error(`Invalid targetHeight for ${model.id}`);
      if (!model.animations?.idle) throw new Error(`Missing idle animation for ${model.id}`);
    }
    for (const profile of this.profiles.values()) {
      if (!profile.id || !profile.role || !this.models.has(profile.modelId)) {
        throw new Error(`Invalid character profile: ${profile.id || 'unknown'}`);
      }
    }
    for (const [unitId, profileId] of this.unitBindings) {
      if (!unitId || !this.profiles.has(profileId)) throw new Error(`Invalid unit binding: ${unitId}`);
    }
    for (const profile of this.selection) {
      if (!profile.name || !profile.description) throw new Error(`Selectable character ${profile.id} is missing presentation text`);
    }
  }

  getProfile(id) {
    return this.profiles.get(id) || null;
  }

  getModel(id) {
    return this.models.get(id) || null;
  }

  profileForUnit(unitId) {
    const profileId = this.unitBindings.get(unitId);
    return profileId ? this.getProfile(profileId) : null;
  }

  modelForProfile(profileId) {
    const profile = this.getProfile(profileId);
    return profile ? this.getModel(profile.modelId) : null;
  }

  modelForUnit(unitId) {
    const profile = this.profileForUnit(unitId);
    return profile ? this.getModel(profile.modelId) : null;
  }

  get modelIds() {
    return [...this.models.keys()];
  }

  get selectedProfiles() {
    return [...this.selection];
  }
}

export { characterData as CHARACTER_DATA };

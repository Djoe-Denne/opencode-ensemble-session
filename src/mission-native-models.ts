import type { MissionPolicyModel } from "./mission-model-policy"

/** The public Model.Info fields needed for mission admission, not remote API IDs. */
export interface NativeMissionModel {
  readonly id: string
  readonly providerID: string
  readonly enabled: boolean
  readonly variants: readonly { readonly id: string }[]
}

/** Expand enabled native models into exact default/variant identities. */
export function nativeMissionModels(models: readonly NativeMissionModel[]): MissionPolicyModel[] {
  return models.filter(model => model.enabled).flatMap(model => {
    const id = `${model.providerID}/${model.id}`
    return [{ id }, ...model.variants.map(variant => ({ id, variant: variant.id }))]
  })
}

import { Service } from "@opencode/client/service"

/** Discover the public shared service without starting it or persisting credentials. */
export async function discoverV2HttpBridge(
  service: Pick<typeof Service, "discover" | "headers"> = Service,
): Promise<{ apiUrl: string; authorization?: string } | undefined> {
  const endpoint = await service.discover()
  if (!endpoint) return undefined
  return { apiUrl: endpoint.url, authorization: service.headers(endpoint)?.authorization }
}

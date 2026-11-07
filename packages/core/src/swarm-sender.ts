import { listSwarms, type SwarmFile } from "./swarm.js";
import type { WalletStore } from "./wallet-store.js";

export type SenderOwnership = { accounts: string[]; swarms: SwarmFile[] };

/** The sole address/key-reference ownership resolver for lock planning and broadcasts. */
export async function resolveSenderOwnership(
  store: WalletStore,
  sender: { address?: string; account?: string; accounts?: readonly string[] },
): Promise<SenderOwnership> {
  await store.refreshRegistry();
  const wallets = await store.list();
  const swarms = await listSwarms(store.home);
  const walletAddresses = new Map(wallets.map((wallet) => [wallet.name, wallet.address]));
  const references: Array<{ account: string; addresses: string[] }> = wallets.map((wallet) => ({
    account: wallet.name,
    addresses: wallet.address === undefined ? [] : [wallet.address.toLowerCase()],
  }));
  for (const swarm of swarms) {
    for (const member of [swarm.treasury, ...swarm.members]) {
      const local =
        walletAddresses.get(member.account) ?? (await store.readAddress(member.account));
      references.push({
        account: member.account,
        addresses: [member.address, local]
          .filter((value): value is string => value !== undefined)
          .map((value) => value.toLowerCase()),
      });
    }
  }
  const accounts = new Set([
    ...(sender.accounts ?? []),
    ...(sender.account === undefined ? [] : [sender.account]),
  ]);
  const addresses = new Set(sender.address === undefined ? [] : [sender.address.toLowerCase()]);
  let changed = true;
  while (changed) {
    const before = accounts.size + addresses.size;
    for (const reference of references) {
      if (
        !accounts.has(reference.account) &&
        !reference.addresses.some((address) => addresses.has(address))
      )
        continue;
      accounts.add(reference.account);
      for (const address of reference.addresses) addresses.add(address);
    }
    changed = before !== accounts.size + addresses.size;
  }
  return {
    accounts: [...accounts].sort(),
    swarms: swarms.filter((swarm) =>
      [swarm.treasury, ...swarm.members].some((member) => accounts.has(member.account)),
    ),
  };
}

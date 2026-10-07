// A ccc signer backed by the user's Corven Connect wallet. Use it like any
// other ccc signer:
//
//   const signer = connect.getSigner('TESTNET');
//   const tx = ccc.Transaction.from({ outputs: [{ lock, capacity }] });
//   await tx.completeInputsByCapacity(signer);
//   await tx.completeFeeBy(signer);
//   const hash = await signer.sendTransaction(tx);
//
// Transactions are built in the browser; signing happens on Corven's server
// after the user approves (the approval handler, e.g. the React modal).

import { ccc } from '@ckb-ccc/core';

import type { CorvenConnect } from './client';
import { CorvenConnectError, UserRejectedError } from './errors';
import type { Network, SignRequest } from './types';

export class CorvenConnectSigner extends ccc.SignerCkbPublicKey {
    constructor(
        client: ccc.Client,
        publicKey: ccc.HexLike,
        private readonly corven: CorvenConnect,
        readonly network: Network,
    ) {
        super(client, publicKey);
    }

    async signOnlyTransaction(txLike: ccc.TransactionLike): Promise<ccc.Transaction> {
        const tx = ccc.Transaction.from(txLike);
        const request = await describe(tx, this);

        const approval = await this.corven.approve(request);
        if (!approval.approved) throw new UserRejectedError();

        const signed = await this.corven.signTransaction(this.network, request.transaction, approval.stepUpToken);
        return ccc.Transaction.from(signed.transaction as ccc.TransactionLike);
    }

    async signMessageRaw(): Promise<string> {
        throw new CorvenConnectError('Corven Connect wallets sign transactions only.', 0, 'unsupported');
    }
}

/** What the transaction does to the user's wallet, for the approval screen. */
export async function describe(tx: ccc.Transaction, signer: CorvenConnectSigner): Promise<SignRequest> {
    const own = (await signer.getAddressObjSecp256k1()).script;
    const client = signer.client;

    let spent = 0n;
    let inputs = 0n;
    for (const input of tx.inputs) {
        const cell = await input.getCell(client);
        inputs += cell.cellOutput.capacity;
        if (cell.cellOutput.lock.eq(own)) spent += cell.cellOutput.capacity;
    }

    let back = 0n;
    let outputs = 0n;
    const recipients: SignRequest['recipients'] = [];
    for (const output of tx.outputs) {
        outputs += output.capacity;
        if (output.lock.eq(own)) back += output.capacity;
        else recipients.push({ address: ccc.Address.fromScript(output.lock, client).toString(), capacity: output.capacity });
    }

    return {
        network: signer.network,
        transaction: JSON.parse(ccc.stringify(tx)),
        outflow: spent > back ? spent - back : 0n,
        recipients,
        fee: inputs >= outputs ? inputs - outputs : null,
    };
}

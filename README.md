# IRAP Verification Explorer

A static reference implementation of the Idea Rendering Attestation Protocol: **Idea → exact Git State → Rendering → attributable Attestation → historical Verification Policy**.

The product intentionally distinguishes a valid signature from a policy-recognized verification. See [`SPEC.yaml`](./SPEC.yaml), [`product.md`](./product.md), and [`acceptance.md`](./acceptance.md).

## Develop

```sh
npm install
npm run dev
```

## Verify

```sh
npm test
npm run build
```

The production output is `dist/` and uses relative asset paths for static Caddy hosting.

## Provenance note

The source ChatGPT conversation's final response exposed the generated protocol package only as unavailable content-reference placeholders. The repository documents are therefore a faithful reconstruction from the recoverable final summary and prior design turns, not a byte-for-byte export. That limitation is recorded inside `SPEC.yaml` rather than hidden.

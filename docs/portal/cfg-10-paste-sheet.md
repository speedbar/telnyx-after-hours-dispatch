# cfg-10: known caller (22 Nov 2026)

Why: dynamic variables reach the model (cfg-10a, the `Caller record:` line under the Callback number paragraph), but the model runs the whole call from the Triage node (every turn of the 22 Nov 18:17 call had flow_node_id triage), so the known-caller rule that lives in the Details node never fires. The rule must be in the assistant Instructions, in steps 2 and 3 of "Order of the call".

Evidence: call 511cb0b0 (22 Nov 18:17): the assistant asked "What's the full address" for a known caller, said it had no details, and only read "Is that Nabeel, at 1 CBD, Sydney?" after the caller challenged it. It then asked "Can I have your name?" straight after reading the name.

## cfg-10a: one line under the Callback number paragraph (already applied)

```
Caller record: caller_known={{caller_known}}, customer_name={{customer_name}}, customer_address={{customer_address}}.
```

## cfg-10b: replace steps 2 and 3 of "Order of the call" in the assistant Instructions

```
2. If caller_known is true and customer_address is not blank, do not ask for the address. Ask: "Is the problem at" and then customer_address, and wait for a yes. If the caller says no, or caller_known is not true, ask for the full address including suburb in one question, read it back once and wait for a yes.
3. If caller_known is true and customer_name is a real name, ask: "Am I speaking with" and then customer_name, and wait for a yes. A yes is the confirmation, so do not ask for the name again. If the caller says no, or caller_known is not true, ask: "Can I have your name?" Take a name only from the caller's answer to that question, never from other words they said. Read it back once as "Is that" and the name, and wait for a yes. If they correct it, use their version and read it back once more. If you did not catch a name, ask once more. Then settle the callback number as described in the Callback number paragraph: offer the caller's own number if there is one, otherwise ask for one.
```

Steps 1, 4, 5 and 6 are unchanged. The Details node already carries a matching rule and stays as it is.

## Tests (voice, from a seeded number)
1. Known caller: "burst pipe, kitchen". Expect: "Is the problem at 1 CBD, Sydney?" then "Am I speaking with Nabeel?", then the callback offer, no "Can I have your name?".
2. Known caller says "no" to the address: expect the normal full-address question.
3. Unknown caller (Portal Test assistant or another number): unchanged flow, name asked and read back.

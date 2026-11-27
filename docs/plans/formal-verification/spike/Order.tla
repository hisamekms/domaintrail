---------------- MODULE Order ----------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT
  \* @type: Str;
  SEED
ASSUME SEED \in {"none", "missing_requires_additem", "missing_requires_confirm", "creation_items_param", "changenote_on_cancelled", "confirm_never_enabled", "cancel_disabled"}

(***************************************************************************)
(* Profile scope: 2 order IDs, 2 customer IDs, 2 item IDs, 2 SKU values,
   quantities 1..2, 2 currencies, 2 timestamps, 2 optional notes, and at
   most 2 items. These are scope bounds, not source guards. *)
CONSTANT
  \* @type: Str;
  O1
CONSTANT
  \* @type: Str;
  O2
CONSTANT
  \* @type: Str;
  C1
CONSTANT
  \* @type: Str;
  C2
CONSTANT
  \* @type: Str;
  I1
CONSTANT
  \* @type: Str;
  I2
CONSTANT
  \* @type: Str;
  S1
CONSTANT
  \* @type: Str;
  S2
CONSTANT
  \* @type: Str;
  JPY
CONSTANT
  \* @type: Str;
  USD
CONSTANT
  \* @type: Str;
  T1
CONSTANT
  \* @type: Str;
  T2
CONSTANT
  \* @type: Str;
  None
IDs == {O1, O2}
Customers == {C1, C2}
ItemIDs == {I1, I2}
Skus == {S1, S2}
Currencies == {JPY, USD}
Times == {T1, T2}
Notes == {None, "memo"}
Reasons == {"Requested", "Other"}
VARIABLE
  \* @type: Str;
  status
VARIABLE
  \* @type: Str;
  orderId
VARIABLE
  \* @type: Str;
  customer
VARIABLE
  \* @type: Seq({id: Str, sku: Str, quantity: Int, currency: Str});
  items
VARIABLE
  \* @type: Str;
  note
VARIABLE
  \* @type: Str;
  confirmedAt
VARIABLE
  \* @type: Str;
  reason
vars == <<status, orderId, customer, items, note, confirmedAt, reason>>
ItemSet == [id : ItemIDs, sku : Skus, quantity : {1, 2}, currency : Currencies]
Items == {<<>>} \cup {<<x>> : x \in ItemSet} \cup {<<x, y>> : x, y \in ItemSet}

(* examples/shop/sales/order.dt:26-28. Binding create IDs to fields is an explicit modeling assumption. *)
Absent ==
    /\ status = "Absent"
    /\ orderId = None
    /\ customer = None
    /\ items = <<>>
    /\ note = None
    /\ confirmedAt = None
    /\ reason = None
Init == Absent
Place(oid, cid, its) ==
    /\ status = "Absent"
    /\ oid \in IDs
    /\ cid \in Customers
    /\ its \in Items
    /\ orderId' = oid
    /\ customer' = cid
    /\ status' = "Draft"
    /\ (IF SEED = "creation_items_param" THEN items' = its ELSE items' \in Items)
    /\ note' \in Notes
    /\ confirmedAt' = None
    /\ reason' = None


(* examples/shop/sales/order.dt:43-49. Len(items)<2 is a profile scope bound; changed items are unspecified. Rejections stutter. *)
AddItem(it) ==
    /\ status = "Draft"
    /\ Len(items) < 2
    /\ it \in ItemSet
    /\ (IF SEED = "missing_requires_additem" THEN TRUE ELSE (\A i \in DOMAIN items: items[i].sku # it.sku))
    /\ (\A i \in DOMAIN items: items[i].currency = it.currency)
    /\ items' \in Items
    /\ UNCHANGED <<status, orderId, customer, note, confirmedAt, reason>>

(* examples/shop/sales/order.dt:66-70. Argument is retained but does not bind note. *)
ChangeNote(n) ==
    /\ status \in (IF SEED = "changenote_on_cancelled" THEN {"Draft", "Confirmed", "Cancelled"} ELSE {"Draft", "Confirmed"})
    /\ n \in Notes
    /\ note' \in Notes
    /\ UNCHANGED <<status, orderId, customer, items, confirmedAt, reason>>

(* examples/shop/sales/order.dt:51-54. at is retained; timestamp is unspecified. *)
Confirm(at) ==
    /\ status = "Draft"
    /\ at \in Times
    /\ (IF SEED = "missing_requires_confirm" THEN TRUE ELSE Len(items) > 0)
    /\ (IF SEED = "confirm_never_enabled" THEN FALSE ELSE TRUE)
    /\ status' = "Confirmed"
    /\ confirmedAt' \in Times
    /\ UNCHANGED <<orderId, customer, items, note, reason>>

(* examples/shop/sales/order.dt:56-62. reason is not bound; Confirmed-only field is dropped. *)
Cancel(r) ==
    /\ status \in {"Draft", "Confirmed"}
    /\ r \in Reasons
    /\ (IF SEED = "cancel_disabled" THEN FALSE ELSE (r = "Requested" \/ note # None))
    /\ status' = "Cancelled"
    /\ reason' \in Reasons
    /\ confirmedAt' = None
    /\ UNCHANGED <<orderId, customer, items, note>>

TypeOK ==
    /\ status \in {"Draft", "Confirmed", "Cancelled"}
    /\ orderId \in IDs
    /\ customer \in Customers
    /\ items \in Items
    /\ note \in Notes
    /\ confirmedAt \in Times \cup {None}
    /\ reason \in Reasons \cup {None}
(* order.dt:19 *)
QuantitiesPositive == (\A i \in DOMAIN items: items[i].quantity > 0)
(* order.dt:20 *)
DistinctSkus == (\A i, j \in DOMAIN items: i # j => items[i].sku # items[j].sku)
(* order.dt:22-24 *)
SingleCurrency == (\A i, j \in DOMAIN items: items[i].currency = items[j].currency)
(* order.dt:34 *)
HasItems == status = "Confirmed" => Len(items) > 0
(* order.dt:40 *)
OtherNeedsNote == status = "Cancelled" /\ reason = "Other" => note # None
Inv ==
    status = "Absent"
    \/ (TypeOK /\ QuantitiesPositive /\ DistinctSkus /\ SingleCurrency /\ HasItems /\ OtherNeedsNote)
Place_C(oid, cid, its) == Place(oid, cid, its) /\ Inv'
(* its exists only for creation_items_param; it is quantified but otherwise unused. *)
Place_Params == {<<oid, cid, its>> : oid \in IDs, cid \in Customers, its \in Items}
Place_NoSucc == (\A p \in Place_Params: ENABLED Place(p[1],p[2],p[3]) => ENABLED Place_C(p[1],p[2],p[3]))
AddItem_C(it) == AddItem(it) /\ Inv'
AddItem_Params == ItemSet
AddItem_NoSucc == (\A p \in AddItem_Params: ENABLED AddItem(p) => ENABLED AddItem_C(p))
ChangeNote_C(n) == ChangeNote(n) /\ Inv'
ChangeNote_Params == Notes
ChangeNote_NoSucc == (\A p \in ChangeNote_Params: ENABLED ChangeNote(p) => ENABLED ChangeNote_C(p))
Confirm_C(at) == Confirm(at) /\ Inv'
Confirm_Params == Times
Confirm_NoSucc == (\A p \in Confirm_Params: ENABLED Confirm(p) => ENABLED Confirm_C(p))
Cancel_C(r) == Cancel(r) /\ Inv'
Cancel_Params == Reasons
Cancel_NoSucc == (\A p \in Cancel_Params: ENABLED Cancel(p) => ENABLED Cancel_C(p))
Probes == Place_NoSucc /\ AddItem_NoSucc /\ ChangeNote_NoSucc /\ Confirm_NoSucc /\ Cancel_NoSucc

Next ==
    \/ \E p \in Place_Params: Place(p[1],p[2],p[3])
    \/ \E p \in AddItem_Params: AddItem(p)
    \/ \E p \in ChangeNote_Params: ChangeNote(p)
    \/ \E p \in Confirm_Params: Confirm(p)
    \/ \E p \in Cancel_Params: Cancel(p)
NextC ==
    \/ \E p \in Place_Params: Place_C(p[1],p[2],p[3])
    \/ \E p \in AddItem_Params: AddItem_C(p)
    \/ \E p \in ChangeNote_Params: ChangeNote_C(p)
    \/ \E p \in Confirm_Params: Confirm_C(p)
    \/ \E p \in Cancel_Params: Cancel_C(p)
NextOnly_Place == (\E p \in Place_Params : Place(p[1],p[2],p[3])) \/ (\E p \in AddItem_Params : AddItem_C(p)) \/ (\E p \in ChangeNote_Params : ChangeNote_C(p)) \/ (\E p \in Confirm_Params : Confirm_C(p)) \/ (\E p \in Cancel_Params : Cancel_C(p))
NextOnly_AddItem == (\E p \in AddItem_Params : AddItem(p)) \/ (\E p \in Place_Params : Place_C(p[1],p[2],p[3])) \/ (\E p \in ChangeNote_Params : ChangeNote_C(p)) \/ (\E p \in Confirm_Params : Confirm_C(p)) \/ (\E p \in Cancel_Params : Cancel_C(p))
NextOnly_ChangeNote == (\E p \in ChangeNote_Params : ChangeNote(p)) \/ (\E p \in Place_Params : Place_C(p[1],p[2],p[3])) \/ (\E p \in AddItem_Params : AddItem_C(p)) \/ (\E p \in Confirm_Params : Confirm_C(p)) \/ (\E p \in Cancel_Params : Cancel_C(p))
NextOnly_Confirm == (\E p \in Confirm_Params : Confirm(p)) \/ (\E p \in Place_Params : Place_C(p[1],p[2],p[3])) \/ (\E p \in AddItem_Params : AddItem_C(p)) \/ (\E p \in ChangeNote_Params : ChangeNote_C(p)) \/ (\E p \in Cancel_Params : Cancel_C(p))
NextOnly_Cancel == (\E p \in Cancel_Params : Cancel(p)) \/ (\E p \in Place_Params : Place_C(p[1],p[2],p[3])) \/ (\E p \in AddItem_Params : AddItem_C(p)) \/ (\E p \in ChangeNote_Params : ChangeNote_C(p)) \/ (\E p \in Confirm_Params : Confirm_C(p))
ConfirmNeverEnabled == ~\E p \in Confirm_Params : ENABLED Confirm(p)
NotCancelled == status # "Cancelled"
Terminal == status = "Cancelled"
TerminalAwareNext == Next \/ (Terminal /\ UNCHANGED vars)
TerminalAwareNextC == NextC \/ (Terminal /\ UNCHANGED vars)
====

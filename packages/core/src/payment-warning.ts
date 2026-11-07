/** A confirmed payment remains successful when local persistence or follow-up work fails. */
export type PaymentWarning = {
  code:
    | "audit_unavailable"
    | "router_key_unavailable"
    | "balance_unavailable"
    | "purchase_response_unavailable"
    | "receipt_unavailable"
    | "payment_followup_unavailable";
  message: string;
};

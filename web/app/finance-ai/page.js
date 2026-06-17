'use client';
import AiTab from '../_components/AiTab';

export default function FinanceAI() {
  return (
    <AiTab
      title="Finance AI"
      sub="QuickBooks smart alerts — overdue invoices, A/R aging, and cash flow."
      sheet="Finance AI"
      endpoint="/api/ai/finance"
      chatScope="Invoices · expenses · P&L"
      renderLeft={() => null}
    />
  );
}

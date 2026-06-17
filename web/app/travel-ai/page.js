'use client';
import AiTab from '../_components/AiTab';

export default function TravelAI() {
  return (
    <AiTab
      title="Travel AI"
      sub="Navan bookings — flagged trips, budget warnings, and TRF matching."
      sheet="Travel AI"
      endpoint="/api/ai/travel"
      chatScope="Bookings · per-diem · spend"
      renderLeft={() => null}
    />
  );
}

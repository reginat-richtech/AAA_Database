import { redirect } from 'next/navigation';

// Home → Project Tracker is the landing page for the console.
export default function Home() {
  redirect('/project-tracker');
}

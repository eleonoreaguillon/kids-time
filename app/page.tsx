import dynamic from "next/dynamic";

const ChildActorScheduler = dynamic(
  () => import("@/components/child-actor-scheduler"),
  { ssr: false }
);

export default function Page() {
  return <ChildActorScheduler />;
}
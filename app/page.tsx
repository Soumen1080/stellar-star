import dynamic from "next/dynamic";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import Hero from "@/components/landing/Hero";

const StatsSection = dynamic(() => import("@/components/landing/StatsSection"), {
  loading: () => null,
});
const Features = dynamic(() => import("@/components/landing/Features"), {
  loading: () => null,
});
const HowItWorks = dynamic(() => import("@/components/landing/HowItWorks"), {
  loading: () => null,
});
const DarkSection = dynamic(() => import("@/components/landing/DarkSection"), {
  loading: () => null,
});
const Testimonials = dynamic(() => import("@/components/landing/Testimonials"), {
  loading: () => null,
});
const Pricing = dynamic(() => import("@/components/landing/Pricing"), {
  loading: () => null,
});
const CTASection = dynamic(() => import("@/components/landing/CTASection"), {
  loading: () => null,
});

export default function LandingPage() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <StatsSection />
        <Features />
        <HowItWorks />
        <DarkSection />
        <Testimonials />
        <Pricing />
        <CTASection />
      </main>
      <Footer />
    </>
  );
}

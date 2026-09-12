import { HelmetProvider, Helmet } from "react-helmet-async";
import { TooltipProvider } from "@/components/ui/tooltip";

const PageMeta = ({
  title,
  description,
  keywords,
}: {
  title: string;
  description: string;
  keywords?: string;
}) => (
  <Helmet>
    <title>{title}</title>
    <meta name="description" content={description} />
    {keywords && <meta name="keywords" content={keywords} />}
  </Helmet>
);

export const AppWrapper = ({ children }: { children: React.ReactNode }) => (
  <HelmetProvider>
    <TooltipProvider>
      {children}
    </TooltipProvider>
  </HelmetProvider>
);

export default PageMeta;

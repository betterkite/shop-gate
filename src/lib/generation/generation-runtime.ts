import { DataAgentGenerationRuntimeRegistry } from "@/lib/data-agent";
import { RETAIL_GENERATION_HANDLER } from "@/lib/commerce/retail-generation-executor";

export function createApplicationGenerationRuntime(): DataAgentGenerationRuntimeRegistry {
  return new DataAgentGenerationRuntimeRegistry().register(
    RETAIL_GENERATION_HANDLER,
  );
}

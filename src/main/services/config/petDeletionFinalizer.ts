import { deleteAiConnectionWhilePetConfigLocked } from "../ai/aiSettings";
import { screenVisionService } from "../screen/ScreenVisionService";

/** Shared by normal deletion and startup recovery; caller holds the per-pet lock. */
export async function finalizePetDeletionWhilePetConfigLocked(petId: string): Promise<void> {
  await deleteAiConnectionWhilePetConfigLocked(petId);
  await screenVisionService.deleteForPetWhilePetConfigLocked(petId);
}

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import {
  FormActions,
  FormError,
  FormField,
  Modal,
  Select,
  Textarea,
  humanizeStatus,
} from '@/shared/ui';
import { useClassificationLevels } from './use-assets';
import { CLASSIFICATIONS, type InformationAsset } from './asset.types';
import { LevelRules } from './asset-modals';

/**
 * Change an asset's classification — up or down.
 *
 * DIRECTION DECIDES THE ENDPOINT, and therefore the permission. Raising a classification is `manage`;
 * LOWERING it is `information_asset.declassify`, because taking protection away is the act worth
 * separating. The dialog says which one it is about to do, computed from the levels' own ranks rather
 * than from a list of "downgrades" written here.
 */
export function ReclassifyAssetModal({
  asset,
  onClose,
  onSuccess,
}: {
  asset: InformationAsset;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const levels = useClassificationLevels();
  const [classification, setClassification] = useState(asset.classification);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const currentRank = levels.data?.find((level) => level.code === asset.classification)?.rank ?? 0;
  const nextLevel = levels.data?.find((level) => level.code === classification);
  const isDowngrade = (nextLevel?.rank ?? 0) < currentRank;

  const mutation = useMutation({
    mutationFn: async () => {
      // Same body either way; the ENDPOINT is what carries the meaning and the permission.
      const path = isDowngrade
        ? '/v1/information-assets/{id}/declassify'
        : '/v1/information-assets/{id}/reclassify';
      const { error: err } = await api.POST(path, {
        params: { path: { id: asset.id } },
        body: { classification: classification as never, reason },
      });
      if (err) throw new Error(apiErrorMessage(err, 'Failed to change the classification.'));
    },
    onSuccess: () => {
      toast.success(isDowngrade ? 'Asset declassified' : 'Asset reclassified');
      onSuccess();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Reclassify ${asset.reference}`}
      description={
        isDowngrade
          ? 'LOWERING a classification removes protection, so it needs the declassify permission and stays in the history.'
          : 'The change and its reason are appended to the asset’s classification history.'
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <FormField label="New classification" htmlFor="reclassify-level" required>
          <Select
            id="reclassify-level"
            value={classification}
            onChange={(e) => setClassification(e.target.value)}
          >
            {CLASSIFICATIONS.map((code) => (
              <option key={code} value={code}>
                {levels.data?.find((level) => level.code === code)?.label ?? humanizeStatus(code)}
              </option>
            ))}
          </Select>
        </FormField>
        <LevelRules level={nextLevel} />

        <FormField
          label="Reason"
          htmlFor="reclassify-reason"
          required
          hint="What changed about the asset or its use. This is the entry an auditor reads."
        >
          <Textarea
            id="reclassify-reason"
            required
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </FormField>

        <FormError message={error} />

        <FormActions
          loading={mutation.isPending}
          onClose={onClose}
          submitLabel={isDowngrade ? 'Declassify' : 'Reclassify'}
          variant={isDowngrade ? 'danger' : 'primary'}
        />
      </form>
    </Modal>
  );
}

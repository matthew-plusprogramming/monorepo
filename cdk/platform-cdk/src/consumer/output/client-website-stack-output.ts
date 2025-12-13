import { z } from 'zod';

import { CLIENT_WEBSITE_STACK_NAME } from '../../stacks/names';

export const ClientWebsiteStackOutputSchema = z.object({
  [CLIENT_WEBSITE_STACK_NAME]: z.object({
    clientWebsiteBucketName: z.string(),
    clientWebsiteDistributionId: z.string(),
    clientWebsiteDistributionDomainName: z.string(),
    clientWebsiteDistributionHostedZoneId: z.string(),
    clientWebsiteCertificateArn: z.string(),
    clientWebsiteDomainName: z.string(),
    clientWebsiteAlternateDomainNames: z.array(z.string()),
  }),
});

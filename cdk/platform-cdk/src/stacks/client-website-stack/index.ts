import { AwsProvider } from '@cdktf/provider-aws/lib/provider';
import { TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';

import { StandardBackend } from '../../utils/standard-backend';

import type { ClientWebsiteStackProps } from './config';
import {
  CLIENT_WEBSITE_ASSETS_ROOT,
  loadClientWebsiteAssets,
  normalizeDomainConfig,
} from './config';
import {
  createAliasRecords,
  createBucketPolicy,
  createCertificateResources,
  createDistribution,
  createOriginAccessControl,
  createOutputs,
  createWebsiteBucket,
  uploadWebsiteAssets,
} from './resources';

export type { ClientWebsiteStackProps };

export class ClientWebsiteStack extends TerraformStack {
  public constructor(
    scope: Construct,
    id: string,
    props: ClientWebsiteStackProps,
  ) {
    super(scope, id);
    const { region } = props;

    const domainConfig = normalizeDomainConfig(props);
    new StandardBackend(this, id, region);

    const usEast1Provider = new AwsProvider(this, 'clientWebsiteUsEast1', {
      region: 'us-east-1',
      alias: 'us-east-1',
    });

    const bucketResources = createWebsiteBucket(this, region);
    const originAccessControl = createOriginAccessControl(this);

    const { certificate, validation } = createCertificateResources(
      this,
      domainConfig,
      usEast1Provider,
    );

    const distribution = createDistribution(
      this,
      bucketResources.bucket,
      originAccessControl,
      certificate,
      domainConfig.domainNames,
      validation,
    );

    createBucketPolicy(this, region, bucketResources.bucket, distribution);
    uploadWebsiteAssets(
      this,
      region,
      CLIENT_WEBSITE_ASSETS_ROOT,
      bucketResources,
      loadClientWebsiteAssets(CLIENT_WEBSITE_ASSETS_ROOT),
    );
    createAliasRecords(this, domainConfig, distribution);
    createOutputs(
      this,
      bucketResources.bucket,
      distribution,
      certificate,
      domainConfig,
    );
  }
}

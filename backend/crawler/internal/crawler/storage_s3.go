package crawler

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type S3ObjectStore struct {
	bucket string
	client *s3.Client
}

func NewS3ObjectStore(ctx context.Context, config Config) (*S3ObjectStore, error) {
	if config.S3Bucket == "" {
		return nil, errors.New("S3_BUCKET is required")
	}
	if config.S3Region == "" {
		return nil, errors.New("S3_REGION is required")
	}
	if (config.S3AccessKeyID == "") != (config.S3SecretAccessKey == "") {
		return nil, errors.New(
			"S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be configured together",
		)
	}

	loadOptions := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion(config.S3Region),
	}
	if config.S3AccessKeyID != "" {
		loadOptions = append(
			loadOptions,
			awsconfig.WithCredentialsProvider(
				credentials.NewStaticCredentialsProvider(
					config.S3AccessKeyID,
					config.S3SecretAccessKey,
					"",
				),
			),
		)
	}
	awsConfig, err := awsconfig.LoadDefaultConfig(ctx, loadOptions...)
	if err != nil {
		return nil, fmt.Errorf("load S3 configuration: %w", err)
	}
	client := s3.NewFromConfig(awsConfig, func(options *s3.Options) {
		options.UsePathStyle = config.S3UsePathStyle
		if config.S3EndpointURL != "" {
			options.BaseEndpoint = aws.String(config.S3EndpointURL)
		}
	})
	store := &S3ObjectStore{bucket: config.S3Bucket, client: client}
	if err := store.ensureBucket(ctx, config.S3CreateBucket, config.S3Region); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *S3ObjectStore) Put(
	ctx context.Context,
	key string,
	contentType string,
	contentEncoding string,
	body []byte,
) (string, error) {
	input := &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(body),
		ContentType: aws.String(contentType),
	}
	if contentEncoding != "" {
		input.ContentEncoding = aws.String(contentEncoding)
	}
	if _, err := s.client.PutObject(ctx, input); err != nil {
		return "", err
	}
	return fmt.Sprintf("s3://%s/%s", s.bucket, key), nil
}

func (s *S3ObjectStore) ensureBucket(
	ctx context.Context,
	create bool,
	region string,
) error {
	if _, err := s.client.HeadBucket(
		ctx,
		&s3.HeadBucketInput{Bucket: aws.String(s.bucket)},
	); err == nil {
		return nil
	} else if !create {
		return fmt.Errorf("access S3 bucket %q: %w", s.bucket, err)
	}

	input := &s3.CreateBucketInput{Bucket: aws.String(s.bucket)}
	if region != "us-east-1" {
		input.CreateBucketConfiguration = &s3types.CreateBucketConfiguration{
			LocationConstraint: s3types.BucketLocationConstraint(region),
		}
	}
	if _, err := s.client.CreateBucket(ctx, input); err != nil {
		return fmt.Errorf("create S3 bucket %q: %w", s.bucket, err)
	}
	return nil
}

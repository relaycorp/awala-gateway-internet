{{/* vim: set filetype=mustache: */}}
{{/*
Expand the name of the chart.
*/}}
{{- define "relaynet-internet-gateway.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "relaynet-internet-gateway.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "relaynet-internet-gateway.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "relaynet-internet-gateway.labels" -}}
helm.sh/chart: {{ include "relaynet-internet-gateway.chart" . }}
{{ include "relaynet-internet-gateway.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "relaynet-internet-gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "relaynet-internet-gateway.name" . }}
{{- if .Component }}
app.kubernetes.io/component: {{ .Component }}
{{- end }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Generate PoHTTP URI
*/}}
{{- define "relaynet-internet-gateway.pohttpUri" -}}
http{{ ternary "s" "" (and .Values.ingress.enabled .Values.ingress.enableTls) }}://{{ .Values.pohttpHost }}
{{- end }}

{{/*
Generate CogRPC URI
*/}}
{{- define "relaynet-internet-gateway.cogrpcUri" -}}
http{{ ternary "s" "" (and .Values.ingress.enabled .Values.ingress.enableTls) }}://{{ .Values.cogrpcHost }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "relaynet-internet-gateway.serviceAccountName" -}}
{{- include "relaynet-internet-gateway.fullname" . }}
{{- end }}

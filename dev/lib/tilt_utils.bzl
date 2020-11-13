def bash_exec(script_file_name, *args):
  script_file_path = "%s/dev/bin/%s" % (config.main_dir, script_file_name)
  return ['bash', '-o', 'nounset', '-o', 'errexit', '-o', 'pipefail', script_file_path] + list(args)

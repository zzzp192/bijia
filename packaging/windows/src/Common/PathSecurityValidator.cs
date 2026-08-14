using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.Text;

namespace Bijia.Common
{
    public static class PathSecurityValidator
    {
        public const string ProductId = "EFMAT_Bijia";
        public const string MarkerFileName = ".bijia_install_marker";
        private static readonly char[] CmdMetaChars = new char[] { '&', '|', '<', '>', '^', '"', '%', '!', ';', '*', '?' };

        public static bool ValidateInstallPath(string rawPath, out string canonicalPath, out string errorMessage)
        {
            canonicalPath = null;
            errorMessage = null;

            if (string.IsNullOrEmpty(rawPath) || string.IsNullOrEmpty(rawPath.Trim()))
            {
                errorMessage = "安装目录路径不能为空。";
                return false;
            }

            string trimmed = rawPath.Trim();
            if (trimmed.IndexOfAny(CmdMetaChars) >= 0)
            {
                errorMessage = "安装路径包含非法命令行元字符 (&|<>^\"%!*;*?)，已被安全拦截。";
                return false;
            }

            try
            {
                canonicalPath = Path.GetFullPath(trimmed);
            }
            catch (Exception ex)
            {
                errorMessage = "安装路径格式无效: " + ex.Message;
                return false;
            }

            if (canonicalPath.StartsWith(@"\\") || canonicalPath.StartsWith("//"))
            {
                errorMessage = "为保障运行安全与权限控制，不支持安装至 UNC 网络共享路径。";
                return false;
            }

            string root = Path.GetPathRoot(canonicalPath);
            if (string.Equals(canonicalPath.TrimEnd('\\', '/'), root.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase))
            {
                errorMessage = "严禁直接安装至磁盘根驱动器 (如 C:\\ 或 D:\\)。请指定子目录。";
                return false;
            }

            var protectedRoots = new List<string>();
            AddSafePath(protectedRoots, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
            AddSafePath(protectedRoots, Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
            AddSafePath(protectedRoots, Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments));
            AddSafePath(protectedRoots, Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
            AddSafePath(protectedRoots, Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
            AddSafePath(protectedRoots, Environment.GetFolderPath(Environment.SpecialFolder.Windows));
            AddSafePath(protectedRoots, Environment.GetFolderPath(Environment.SpecialFolder.System));
            AddSafePath(protectedRoots, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
            AddSafePath(protectedRoots, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86));

            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrEmpty(userProfile))
            {
                AddSafePath(protectedRoots, Path.Combine(userProfile, "Downloads"));
            }

            foreach (var p in protectedRoots)
            {
                if (string.Equals(canonicalPath.TrimEnd('\\', '/'), p.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase))
                {
                    errorMessage = "严禁安装至系统保护目录或根用户目录 (" + p + ")。";
                    return false;
                }
            }

            if (Directory.Exists(canonicalPath))
            {
                string[] entries = Directory.GetFileSystemEntries(canonicalPath);
                if (entries != null && entries.Length > 0)
                {
                    string markerPath = Path.Combine(canonicalPath, MarkerFileName);
                    if (!File.Exists(markerPath))
                    {
                        errorMessage = "目标目录已存在其他文件且不属于已有安装实例。为防止数据覆盖，请选择空目录或已安装目录。";
                        return false;
                    }

                    string markerErr;
                    if (!ValidateInstallMarker(canonicalPath, out markerErr))
                    {
                        errorMessage = "目标目录下的安装标记损坏或产品标识不匹配，拒绝写入。";
                        return false;
                    }
                }
            }

            return true;
        }

        public static bool ValidateUninstallPath(string installDir, out string errorMessage)
        {
            errorMessage = null;
            if (string.IsNullOrEmpty(installDir) || !Directory.Exists(installDir))
            {
                errorMessage = "安装目录不存在或已被移除。";
                return false;
            }

            string canonical;
            if (!ValidateInstallPath(installDir, out canonical, out errorMessage))
            {
                return false;
            }

            if (!ValidateInstallMarker(canonical, out errorMessage))
            {
                return false;
            }

            return true;
        }

        public static void CreateInstallMarker(string installDir, string version)
        {
            string markerPath = Path.Combine(installDir, MarkerFileName);
            string json = string.Format(
                "{{\r\n  \"productId\": \"{0}\",\r\n  \"version\": \"{1}\",\r\n  \"installedAt\": \"{2:yyyy-MM-dd HH:mm:ss}\"\r\n}}",
                ProductId,
                version ?? "1.0.0",
                DateTime.Now
            );
            File.WriteAllText(markerPath, json, Encoding.UTF8);
        }

        public static bool ValidateInstallMarker(string installDir, out string errorMessage)
        {
            errorMessage = null;
            string markerPath = Path.Combine(installDir, MarkerFileName);
            if (!File.Exists(markerPath))
            {
                errorMessage = "未在目录中找到安装认证标记 (" + MarkerFileName + ")，拒绝执行卸载。";
                return false;
            }

            try
            {
                string content = File.ReadAllText(markerPath, Encoding.UTF8);
                if (!content.Contains("\"productId\"") || !content.Contains(ProductId))
                {
                    errorMessage = "安装认证标记的产品标识不匹配，拒绝卸载。";
                    return false;
                }
                return true;
            }
            catch (Exception ex)
            {
                errorMessage = "读取安装认证标记失败: " + ex.Message;
                return false;
            }
        }

        public static bool IsSafeExtractionPath(string targetRootWithSep, string candidatePath)
        {
            try
            {
                string fullPath = Path.GetFullPath(candidatePath);
                return fullPath.StartsWith(targetRootWithSep, StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        private static void AddSafePath(List<string> list, string path)
        {
            if (string.IsNullOrEmpty(path)) return;
            try
            {
                string full = Path.GetFullPath(path);
                if (!list.Contains(full))
                {
                    list.Add(full);
                }
            }
            catch { }
        }
    }
}
